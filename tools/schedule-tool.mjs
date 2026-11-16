#!/usr/bin/env node
/**
 * THE PUBLIC SMARTTV SCHEDULE, BUILT AND CHECKED WHERE NOTHING PRIVATE EXISTS.
 *
 *     node tools/schedule-tool.mjs build --at <ISO instant> --out <dir> [--previous <file>]
 *                                        [--lead-hours 48] [--self-test-corrupt]
 *     node tools/schedule-tool.mjs check <file>
 *
 * Runs in GitHub Actions (or anywhere with Node 20+), with no dependencies, no
 * network and no secrets. It is NOT the SmartTV publisher and contains none of
 * its code: it understands exactly two inputs, both public by design.
 *
 *   source/channels.json   WRITTEN channels - a fixed list of catalogue
 *                          programmes (tmdb:movie:N / tmdb:episode:S:s:e) with
 *                          their titles and lengths, repeating for ever. These
 *                          are laid out here. Anything else - a composed or
 *                          timed channel, a household file - is refused.
 *   source/weeks/*.json    TIMED channels, one complete snapshot-v2 file per
 *                          week, made ahead of time by the full publisher on
 *                          the household PC (`npm run publish:public`). Here
 *                          they are only checked, chosen and merged in.
 *
 * WHICH WEEK. The file published is the one covering (now + lead): with the
 * default 48 hours, next week's goes out on the Saturday before it, so every
 * phone has it saved as upcoming before Monday 00:00 and switches at that
 * instant even with no internet. Before then, this week's.
 *
 * NOTHING IS WRITTEN UNLESS EVERY CHECK PASSES - the build is checked again as
 * the text it will publish, and built twice to prove it is deterministic. If
 * it differs from the previous file only in generatedAtMs, the previous bytes
 * are kept (changed=false) so a phone sees no new version for nothing.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORMAT_VERSION = 2;
export const GAP_TITLE = 'Nothing scheduled';
/** The most the SmartTV app accepts (remoteScheduleConfig.ts MAX_SCHEDULE_BYTES). */
export const MAX_BYTES = 1_500_000;
export const DEFAULT_LEAD_MS = 48 * 3_600_000;

const MOVIE = /^tmdb:movie:(\d+)$/;
const EPISODE = /^tmdb:episode:(\d+):(\d+):(\d+)$/;
const SERIES = /^tmdb:tv:(\d+)$/;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/;
const CATALOGUE = JSON.stringify({ method: 'catalogue' });

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isInt = (n) => Number.isInteger(n);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

/** The objects of a definitions file without their `//` commentary. */
function withoutCommentary(value) {
  if (Array.isArray(value)) return value.map(withoutCommentary);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('//')).map(([k, v]) => [k, withoutCommentary(v)]));
}

function describeSlot(slot, where, problems) {
  if (typeof slot.mediaId === 'string') {
    problems.push(`${where} is a household file ("mediaId"); a public schedule cannot carry one.`);
    return null;
  }
  const id = slot.contentId;
  const movie = typeof id === 'string' ? MOVIE.exec(id) : null;
  const episode = typeof id === 'string' ? EPISODE.exec(id) : null;
  if (!movie && !episode) {
    problems.push(`${where} names ${JSON.stringify(id)}, which is not a catalogue film or episode (tmdb:movie:N or tmdb:episode:SHOW:SEASON:EPISODE).`);
    return null;
  }
  if (typeof slot.title !== 'string' || slot.title.trim() === '') {
    problems.push(`${where} has no title.`);
    return null;
  }
  const durationMs = Math.round(Number(slot.durationSeconds) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    problems.push(`${where} needs a positive durationSeconds - a public schedule states every length.`);
    return null;
  }
  const content = {
    id,
    title: slot.title,
    kind: movie ? 'movie' : 'episode',
    episode: episode ? { seriesId: `tmdb:tv:${episode[1]}`, seasonNumber: Number(episode[2]), episodeNumber: Number(episode[3]) } : null,
    imageUrl: null,
    playback: { method: 'catalogue' },
  };
  const seriesTitle = episode ? (typeof slot.seriesTitle === 'string' && slot.seriesTitle !== '' ? slot.seriesTitle : null) : undefined;
  return { content, durationMs, seriesTitle };
}

/** The written channels of a line-up, laid out exactly as the SmartTV publisher lays them. */
export function generateWritten(lineup, atMs) {
  const problems = [];
  const channels = [];
  const described = new Map();
  const series = new Map();
  const definitions = Array.isArray(lineup?.channels) ? withoutCommentary(lineup.channels) : null;
  if (definitions === null) return { problems: ['The line-up has no "channels" list.'], snapshot: null };

  for (const [index, def] of definitions.entries()) {
    const where = `Channel ${index + 1} (${JSON.stringify(def.id)})`;
    if (Array.isArray(def.groups) && def.groups.length > 0) {
      problems.push(`${where} is a composed channel; publish it as a weekly file in source/weeks, made by the SmartTV publisher.`);
      continue;
    }
    if (typeof def.id !== 'string' || !CHANNEL_ID.test(def.id)) problems.push(`${where} needs a plain id.`);
    if (!isInt(def.number) || def.number <= 0) problems.push(`${where} needs a positive whole channel number.`);
    if (typeof def.name !== 'string' || def.name.trim() === '') problems.push(`${where} needs a name.`);
    const epochMs = Date.parse(def.epoch);
    if (!Number.isFinite(epochMs)) problems.push(`${where} needs an epoch (an ISO instant).`);
    if (!Array.isArray(def.schedule) || def.schedule.length === 0) {
      problems.push(`${where} needs a schedule of at least one programme.`);
      continue;
    }
    const programmes = [];
    def.schedule.forEach((slot, position) => {
      const slotWhere = `${where} programme ${position + 1}`;
      const one = describeSlot(slot ?? {}, slotWhere, problems);
      if (!one) return;
      programmes.push({ id: one.content.id, durationMs: one.durationMs });
      const earlier = described.get(one.content.id);
      if (earlier && JSON.stringify(earlier.content) !== JSON.stringify(one.content)) {
        problems.push(`"${one.content.id}" is described two ways - at ${earlier.where} and ${slotWhere}.`);
      } else if (!earlier) described.set(one.content.id, { content: one.content, where: slotWhere });
      if (one.content.episode) {
        const seriesId = one.content.episode.seriesId;
        if (series.has(seriesId) && series.get(seriesId) !== one.seriesTitle) {
          problems.push(`Series "${seriesId}" is named two ways; a published schedule names a series once.`);
        } else series.set(seriesId, one.seriesTitle);
      }
    });
    channels.push({ id: def.id, number: def.number, name: def.name, timeZone: null, epochMs, repeats: true, programmes });
  }
  if (problems.length > 0) return { problems, snapshot: null };
  return {
    problems,
    snapshot: {
      formatVersion: FORMAT_VERSION,
      generatedAtMs: atMs,
      validUntilMs: null,
      gapTitle: GAP_TITLE,
      channels: channels.sort((a, b) => a.number - b.number),
      content: [...described.values()].map((entry) => entry.content).sort(byId),
      series: [...series].map(([id, title]) => ({ id, title })).sort(byId),
    },
  };
}

const cycleOf = (channel) => channel.programmes.reduce((sum, p) => sum + p.durationMs, 0);

/**
 * Every rule a public schedule must keep - independent of SmartTV's own reader,
 * and stricter where publishing is concerned (catalogue identities only, no
 * household files, nothing shaped like an address, a path or a credential).
 */
export function checkSnapshot(value, text) {
  const problems = [];
  const fail = (sentence) => problems.length < 50 && problems.push(sentence);
  if (typeof text === 'string' && Buffer.byteLength(text) > MAX_BYTES) fail(`The file is ${Buffer.byteLength(text)} bytes; the app accepts at most ${MAX_BYTES}.`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['The file is not a JSON object.'];
  if (value.formatVersion !== FORMAT_VERSION) return [`formatVersion is ${JSON.stringify(value.formatVersion)}; only ${FORMAT_VERSION} is published.`];
  if (!Number.isFinite(value.generatedAtMs)) fail('generatedAtMs must be an instant in milliseconds.');
  if (value.validUntilMs !== null && !Number.isFinite(value.validUntilMs)) fail('validUntilMs must be null or an instant.');
  if (typeof value.gapTitle !== 'string' || value.gapTitle.trim() === '') fail('gapTitle must be a name.');
  for (const key of ['channels', 'content', 'series']) if (!Array.isArray(value[key])) return [...problems, `"${key}" must be a list.`];
  if (value.channels.length === 0) fail('There are no channels.');

  const used = new Set();
  const ids = new Set();
  const numbers = new Set();
  let firstEnd = null;
  value.channels.forEach((channel, index) => {
    const where = `Channel ${index + 1}`;
    if (typeof channel.id !== 'string' || !CHANNEL_ID.test(channel.id) || ids.has(channel.id)) fail(`${where} needs a unique plain id.`);
    if (!isInt(channel.number) || channel.number <= 0 || numbers.has(channel.number)) fail(`${where} needs a unique positive number.`);
    ids.add(channel.id);
    numbers.add(channel.number);
    if (typeof channel.name !== 'string' || channel.name.trim() === '' || channel.name.length > 200) fail(`${where} needs a name of at most 200 characters.`);
    if (channel.timeZone !== null && (typeof channel.timeZone !== 'string' || !ZONE.test(channel.timeZone))) fail(`${where} has an unusable timeZone.`);
    if (!Number.isFinite(channel.epochMs)) fail(`${where} needs an epochMs.`);
    if (typeof channel.repeats !== 'boolean') fail(`${where} must say whether it repeats.`);
    if (!Array.isArray(channel.programmes) || channel.programmes.length === 0) {
      fail(`${where} has no programmes.`);
      return;
    }
    for (const programme of channel.programmes) {
      if (!isInt(programme?.durationMs) || programme.durationMs <= 0) fail(`${where} has a programme without a positive whole durationMs.`);
      if (programme?.id !== null && typeof programme?.id !== 'string') fail(`${where} has a programme with an id that is neither text nor null.`);
      if (typeof programme?.id === 'string') used.add(programme.id);
      if (programme?.id === null && channel.repeats) fail(`${where} repeats but has a gap; only a timed week has gaps.`);
    }
    if (!channel.repeats && Number.isFinite(channel.epochMs)) {
      const end = channel.epochMs + cycleOf(channel);
      if (firstEnd === null || end < firstEnd) firstEnd = end;
    }
  });
  if (value.validUntilMs !== firstEnd) fail(`validUntilMs is ${value.validUntilMs}, but the first channel to end ends at ${firstEnd}.`);

  const described = new Set();
  const seriesUsed = new Set();
  for (const entry of value.content) {
    const where = `Content ${JSON.stringify(entry?.id)}`;
    if (typeof entry?.id !== 'string' || described.has(entry.id)) fail(`${where} must have a unique id.`);
    described.add(entry?.id);
    const movie = MOVIE.exec(entry?.id ?? '');
    const episode = EPISODE.exec(entry?.id ?? '');
    if (!movie && !episode) fail(`${where} is not a catalogue film or episode; a public schedule carries nothing else.`);
    if (typeof entry?.title !== 'string' || entry.title.trim() === '' || entry.title.length > 500) fail(`${where} needs a title of at most 500 characters.`);
    if (entry?.kind !== (movie ? 'movie' : 'episode')) fail(`${where} has kind ${JSON.stringify(entry?.kind)}, which its id contradicts.`);
    if (movie && entry.episode !== null) fail(`${where} is a film but carries an episode.`);
    if (episode) {
      const e = entry.episode;
      if (!e || e.seriesId !== `tmdb:tv:${episode[1]}` || e.seasonNumber !== Number(episode[2]) || e.episodeNumber !== Number(episode[3])) fail(`${where} has an episode that its id contradicts.`);
      else seriesUsed.add(e.seriesId);
    }
    if (entry?.imageUrl !== null && !(typeof entry?.imageUrl === 'string' && /^https:\/\/[^\s"'<>]+$/.test(entry.imageUrl) && entry.imageUrl.length <= 2048)) fail(`${where} has a picture that is not a plain https address.`);
    if (JSON.stringify(entry?.playback) !== CATALOGUE) fail(`${where} is not played from the catalogue; household files are never published.`);
  }
  for (const id of used) if (!described.has(id)) fail(`Programme "${id}" is on air but not described.`);
  for (const id of described) if (!used.has(id)) fail(`Content "${id}" is described but never on air.`);
  const named = new Set();
  for (const entry of value.series) {
    if (typeof entry?.id !== 'string' || !SERIES.test(entry.id) || named.has(entry.id)) fail(`Series ${JSON.stringify(entry?.id)} needs a unique tmdb:tv id.`);
    named.add(entry?.id);
    if (entry?.title !== null && typeof entry?.title !== 'string') fail(`Series ${JSON.stringify(entry?.id)} has a title that is neither text nor null.`);
    if (!seriesUsed.has(entry?.id)) fail(`Series ${JSON.stringify(entry?.id)} belongs to no programme.`);
  }
  for (const id of seriesUsed) if (!named.has(id)) fail(`Series "${id}" is used but not listed.`);

  // Nothing shaped like an address (outside a picture), a path or a credential.
  (function scan(node, key) {
    if (typeof node === 'string') {
      const picture = key === 'imageUrl';
      if (!picture && node.includes('://')) fail(`A text value holds an address: ${JSON.stringify(node.slice(0, 60))}.`);
      if (/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(node) || node.includes('\\')) fail('A text value looks like a local path.');
      if (/\/(media|api)\//.test(node) && !picture) fail('A text value looks like a household server route.');
      if (/bearer\s|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9_-]{40,}/i.test(node) && !picture) fail('A text value looks like a credential.');
    } else if (Array.isArray(node)) node.forEach((item) => scan(item, key));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) scan(v, k);
  })(value, '');
  return problems;
}

/** When a weekly file's week begins, and ends. */
export function windowOf(snapshot) {
  let start = null;
  for (const channel of snapshot.channels) if (!channel.repeats && (start === null || channel.epochMs > start)) start = channel.epochMs;
  return { start, end: snapshot.validUntilMs };
}

/** Which week to publish at this instant, and anything worth saying about it. */
export function selectWeek(weeks, atMs, leadMs) {
  const notes = [];
  const covering = (t) => weeks.filter((week) => week.window.start <= t && t < week.window.end);
  for (const t of [atMs, atMs + leadMs]) if (covering(t).length > 1) return { problems: [`More than one week covers ${iso(t)}.`], chosen: null, notes };
  const now = covering(atMs)[0] ?? null;
  const ahead = covering(atMs + leadMs)[0] ?? null;
  if (weeks.length === 0) return { problems: [], chosen: null, notes };
  if (ahead && ahead !== now) {
    notes.push(`next week (${ahead.name}) published ahead of time; it takes over at ${iso(ahead.window.start)}`);
    return { problems: [], chosen: ahead, notes };
  }
  if (now) {
    if (!ahead) notes.push(`WARNING: no week is queued for after ${iso(now.window.end)} - add it to source/weeks before then`);
    return { problems: [], chosen: now, notes };
  }
  return { problems: [`No queued week covers ${iso(atMs)}: source/weeks has run out. The live schedule was left as it is.`], chosen: null, notes };
}

/** A weekly file's channels joined to the written ones - one file, every reference kept. */
export function merge(written, week, atMs) {
  const problems = [];
  const numbers = new Set(written.channels.map((c) => c.number));
  const ids = new Set(written.channels.map((c) => c.id));
  for (const channel of week.channels) {
    if (numbers.has(channel.number) || ids.has(channel.id)) problems.push(`Channel ${channel.number} (${channel.id}) is in both the line-up and the weekly file.`);
  }
  const content = new Map(written.content.map((entry) => [entry.id, entry]));
  for (const entry of week.content) {
    if (content.has(entry.id) && JSON.stringify(content.get(entry.id)) !== JSON.stringify(entry)) problems.push(`"${entry.id}" is described differently in the line-up and the weekly file.`);
    content.set(entry.id, entry);
  }
  const series = new Map(written.series.map((entry) => [entry.id, entry]));
  for (const entry of week.series) {
    if (series.has(entry.id) && series.get(entry.id).title !== entry.title) problems.push(`Series "${entry.id}" is named differently in the line-up and the weekly file.`);
    series.set(entry.id, entry);
  }
  if (problems.length > 0) return { problems, snapshot: null };
  return {
    problems,
    snapshot: {
      formatVersion: FORMAT_VERSION,
      generatedAtMs: atMs,
      validUntilMs: week.validUntilMs,
      gapTitle: written.gapTitle,
      channels: [...written.channels, ...week.channels].sort((a, b) => a.number - b.number),
      content: [...content.values()].sort(byId),
      series: [...series.values()].sort(byId),
    },
  };
}

const withoutStamp = (snapshot) => JSON.stringify({ ...snapshot, generatedAtMs: 0 });

/** Everything build does, without touching the disk: the text to publish, or why not. */
export function buildText({ lineup, weeks, atMs, leadMs = DEFAULT_LEAD_MS, previousText = null }) {
  const written = generateWritten(lineup, atMs);
  if (written.snapshot === null) return { problems: written.problems, notes: [] };
  const checkedWeeks = [];
  for (const week of weeks) {
    const problems = checkSnapshot(week.value, week.text);
    if (problems.length > 0) return { problems: problems.map((p) => `${week.name}: ${p}`), notes: [] };
    if (week.value.channels.some((c) => c.repeats)) return { problems: [`${week.name}: a weekly file holds timed channels only; repeating ones belong in channels.json.`], notes: [] };
    checkedWeeks.push({ ...week, window: windowOf(week.value) });
  }
  const selection = selectWeek(checkedWeeks, atMs, leadMs);
  if (selection.problems.length > 0) return { problems: selection.problems, notes: selection.notes };
  let snapshot = written.snapshot;
  if (selection.chosen) {
    const merged = merge(written.snapshot, selection.chosen.value, atMs);
    if (merged.snapshot === null) return { problems: merged.problems, notes: selection.notes };
    snapshot = merged.snapshot;
  }
  let text = `${JSON.stringify(snapshot)}\n`;
  let changed = true;
  if (previousText !== null) {
    try {
      const previous = JSON.parse(previousText);
      if (checkSnapshot(previous, previousText).length === 0 && withoutStamp(previous) === withoutStamp(snapshot)) {
        text = previousText;
        changed = false;
      }
    } catch {
      // An unreadable previous file is simply not kept.
    }
  }
  return { problems: [], notes: selection.notes, text, changed };
}

function readWeeks(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const text = readFileSync(path.join(directory, name), 'utf8');
      let value = null;
      try {
        value = JSON.parse(text);
      } catch {
        value = null;
      }
      return { name, text, value };
    });
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function report(outputs) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}

export function main(argv) {
  const [command] = argv;
  if (command === 'check') {
    const text = readFileSync(argv[1], 'utf8');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      console.error('FAIL not JSON');
      return 1;
    }
    const problems = checkSnapshot(value, text);
    for (const p of problems) console.error(`FAIL ${p}`);
    if (problems.length === 0) console.log(`ok ${argv[1]}: ${value.channels.length} channel(s), ${Buffer.byteLength(text)} bytes, sha256 ${sha256(text)}`);
    return problems.length === 0 ? 0 : 1;
  }
  if (command !== 'build') {
    console.error('usage: schedule-tool.mjs build --at <ISO> --out <dir> [--previous <file>] [--lead-hours 48] | check <file>');
    return 2;
  }
  const atMs = Date.parse(option(argv, '--at') ?? '');
  const out = option(argv, '--out');
  if (!Number.isFinite(atMs) || !out) {
    console.error('build needs --at <ISO instant> and --out <dir>; the clock is never read.');
    return 2;
  }
  const root = option(argv, '--source') ?? 'source';
  const leadHours = option(argv, '--lead-hours');
  const leadMs = leadHours === null ? DEFAULT_LEAD_MS : Number(leadHours) * 3_600_000;
  const previousPath = option(argv, '--previous');
  const previousText = previousPath && existsSync(previousPath) ? readFileSync(previousPath, 'utf8') : null;
  let lineup;
  try {
    lineup = JSON.parse(readFileSync(path.join(root, 'channels.json'), 'utf8'));
  } catch (error) {
    console.error(`FAIL the line-up could not be read: ${error.message}`);
    return 1;
  }
  const inputs = { lineup, weeks: readWeeks(path.join(root, 'weeks')), atMs, leadMs, previousText };
  const first = buildText(inputs);
  for (const note of first.notes) console.log(`note: ${note}`);
  if (first.problems.length > 0) {
    for (const p of first.problems) console.error(`FAIL ${p}`);
    report({ changed: 'false', result: 'failed' });
    return 1;
  }
  let text = first.text;
  if (argv.includes('--self-test-corrupt')) text = text.slice(0, Math.floor(text.length / 2));
  else if (buildText(inputs).text !== text) {
    console.error('FAIL two builds of the same input differ; nothing is published.');
    return 1;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('FAIL the text to publish is not JSON; nothing was written.');
    report({ changed: 'false', result: 'failed' });
    return 1;
  }
  const problems = checkSnapshot(parsed, text);
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL ${p}`);
    report({ changed: 'false', result: 'failed' });
    return 1;
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'schedule-v2.json'), text);
  writeFileSync(path.join(out, '.nojekyll'), '');
  const digest = sha256(text);
  console.log(`${first.changed ? 'CHANGED' : 'UNCHANGED'} sha256 ${digest} ${Buffer.byteLength(text)} bytes, ${parsed.channels.length} channel(s), valid until ${parsed.validUntilMs === null ? 'replaced' : iso(parsed.validUntilMs)}`);
  report({ changed: String(first.changed), result: first.changed ? 'changed' : 'unchanged', sha256: digest });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
