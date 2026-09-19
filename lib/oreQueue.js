"use strict";

// The "what to mine" queue.
//
// 1.2.3 replaced the three per-kind lists with one ordered queue, because that
// is how a player reads it: "veldspar first, then a moon ore, then kernite" is a
// single order, and three buckets could not express it. 1.2.9 is where the queue
// stopped carrying anything that is not one rock, so a token is now one of
// exactly two shapes:
//
//   veldspar            any rock whose type name contains "veldspar"
//   16268               the rock with that type ID
//
// A name is matched inside the type name, so "veldspar" covers Veldspar,
// Compressed Veldspar and Veldspar IV-Grade alike, and a name of several words is
// one token ("dark ochre") - the comma is the separator that keeps it together.
//
// The words that stood for a whole kind ("ore", "ice", "moon", together with
// "any", "*" and "all") and the pin that hung a name off one kind
// ("ice:glacial mass") are gone from the typed grammar. "ice" is a word inside
// real rock names - Blue Ice, Azure Ice, Glacial Mass - so one rule could not
// mean both, and a filter that names a whole kind is what "filter clear" is for.
// A queue written by an older release still holds those tokens, so readQueue and
// parseStoredToken keep understanding them: an entry stored before 1.2.9 keeps
// mining exactly what it mined, and a reply that prints one keeps saying what it
// means. Nothing a command accepts can create one any more.
//
// The tokens are what the players file stores and what a reply prints, so what a
// player reads is exactly what they can type back.
//
// 1.2.2 stored three per-kind buckets. readQueue still understands that shape,
// so an entry written by the older release, or by hand, keeps working: it is
// expanded into the same tokens, in kind order.
const {
  ORE_FILTER_ANY_ENTRIES,
  ORE_FILTER_MAX_PATTERNS,
  ORE_FILTER_MAX_PATTERN_LENGTH,
  ORE_FILTER_SCOPES,
} = require("../config.js");

// How a token may look once the optional "kind:" prefix is taken off.
const TOKEN_SHAPE = /^[a-z0-9][a-z0-9 .'+_-]*$/u;
const NUMBER_SHAPE = /^\d+$/u;

function toStringValue(value) {
  return String(value == null ? "" : value).trim();
}

function isAnyWord(pattern) {
  return ORE_FILTER_ANY_ENTRIES.includes(pattern);
}

function isKindWord(word) {
  return ORE_FILTER_SCOPES.includes(word);
}

// The words that used to stand for a whole kind of rock. None of them is an
// entry any more, and a command that reads typed words has to say so rather than
// quietly queueing one - which is the whole point: in Blue Ice and Azure Ice the
// word "ice" is part of a rock's own name and has to stay one.
function isReservedWord(word) {
  const text = toStringValue(word).toLowerCase();
  return isKindWord(text) || isAnyWord(text);
}

// The word still carries the 1.2.5 "ice:glacial mass" pin. The pin is gone, and
// naming it is friendlier than "not a usable ore name".
function pinnedTokenKind(word) {
  const text = toStringValue(word).toLowerCase();
  const separator = text.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const prefix = text.slice(0, separator);
  return isKindWord(prefix) ? prefix : null;
}

// "ice:glacial mass" -> { kind: "ice", pattern: "glacial mass" }. A token
// without a usable prefix is a pattern that matches any kind.
function splitKindPrefix(word) {
  const text = toStringValue(word).toLowerCase();
  const separator = text.indexOf(":");
  if (separator <= 0) {
    return { kind: null, pattern: text };
  }
  const prefix = text.slice(0, separator);
  return isKindWord(prefix)
    ? { kind: prefix, pattern: text.slice(separator + 1).trim() }
    : { kind: null, pattern: text };
}

// One typed word -> one entry. This is the whole typed grammar: a rock's name,
// or a type ID. "ore"/"ice"/"moon"/"any"/"*" are words a command has to refuse
// before it gets here, and "ice:glacial mass" is no longer a token at all.
function parseTypedToken(word) {
  const text = toStringValue(word).toLowerCase();
  if (!text || text.length > ORE_FILTER_MAX_PATTERN_LENGTH) {
    return null;
  }
  if (!TOKEN_SHAPE.test(text)) {
    return null;
  }
  return { kind: null, pattern: text };
}

// One token as the players file stores it -> one entry, or null when it is not
// usable. This is the older, wider grammar: "ore"/"ice"/"moon" - with or without
// an explicit "any" - stand for the whole of that kind, and a "kind:name" pin
// hangs a name off one kind. Only a file can produce one of those now.
function parseStoredToken(word) {
  const { kind, pattern } = splitKindPrefix(word);
  if (!pattern || pattern.length > ORE_FILTER_MAX_PATTERN_LENGTH) {
    return null;
  }
  if (isAnyWord(pattern) || isKindWord(pattern)) {
    return { kind: isKindWord(pattern) ? pattern : kind, pattern: "*" };
  }
  if (!TOKEN_SHAPE.test(pattern)) {
    return null;
  }
  return { kind, pattern };
}

// A hand-written { kind, pattern } entry from the players file.
function parseEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rawKind = value.kind === null || value.kind === undefined
    ? null
    : toStringValue(value.kind).toLowerCase();
  if (rawKind !== null && !isKindWord(rawKind)) {
    return null;
  }
  return parseStoredToken(rawKind ? `${rawKind}:${toStringValue(value.pattern)}` : value.pattern);
}

function parseEntries(values) {
  const entries = [];
  for (const value of values) {
    const entry = typeof value === "string" ? parseStoredToken(value) : parseEntry(value);
    if (!entry || entries.some((existing) => sameEntry(existing, entry))) {
      continue;
    }
    entries.push(entry);
    if (entries.length >= ORE_FILTER_MAX_PATTERNS) {
      break;
    }
  }
  return entries;
}

function sameEntry(left, right) {
  return left.kind === right.kind && left.pattern === right.pattern;
}

// The token as the player types it, prints it and the file stores it.
function tokenText(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  if (!entry.kind) {
    return entry.pattern;
  }
  return entry.pattern === "*" ? entry.kind : `${entry.kind}:${entry.pattern}`;
}

// The 1.2.2 shape, {"ore": [names], "ice": [...], "moon": [...]}, expanded into
// tokens. An empty bucket meant "any rock of that kind", so it becomes the kind
// word itself: ["ore", "moon"] reads as "any ore, then any moon ore".
function entriesFromBuckets(raw) {
  const words = [];
  for (const scope of ORE_FILTER_SCOPES) {
    const bucket = raw[scope];
    if (bucket === undefined || bucket === null || bucket === false) {
      continue;
    }
    if (bucket === true) {
      words.push(scope);
      continue;
    }
    const items = Array.isArray(bucket) ? bucket : toStringValue(bucket).split(/[,\s]+/u);
    if (items.length === 0) {
      words.push(scope);
      continue;
    }
    const usable = items.map((item) => toStringValue(item).toLowerCase())
      .filter((item) => item.length > 0 && item.length <= ORE_FILTER_MAX_PATTERN_LENGTH);
    if (usable.length === 0) {
      // The bucket listed something, but none of it was usable: leave the kind
      // out rather than silently widening it to "any rock of this kind".
      continue;
    }
    for (const item of usable) {
      words.push(isAnyWord(item) ? scope : `${scope}:${item}`);
    }
  }
  return parseEntries(words);
}

// Anything the players file or a per-character entry may hold: the tokens
// written since 1.2.3, the per-kind buckets 1.2.2 wrote, a bare name, or
// true/"any". Returns null when nothing usable is left, which is how a cleared
// filter disappears from the file.
function readQueue(rawValue) {
  if (rawValue === null || rawValue === false || rawValue === undefined) {
    return null;
  }
  if (Array.isArray(rawValue)) {
    const entries = parseEntries(rawValue);
    return entries.length > 0 ? entries : null;
  }
  if (typeof rawValue === "boolean") {
    return rawValue ? [{ kind: "ore", pattern: "*" }] : null;
  }
  if (typeof rawValue === "string") {
    const text = toStringValue(rawValue).toLowerCase();
    if (!text) {
      return null;
    }
    const entries = isAnyWord(text)
      ? [{ kind: null, pattern: "*" }]
      : parseEntries(text.split(/[,\s]+/u));
    return entries.length > 0 ? entries : null;
  }
  if (typeof rawValue === "object") {
    const entries = entriesFromBuckets(rawValue);
    return entries.length > 0 ? entries : null;
  }
  return null;
}

// The entries back as the tokens the file stores.
function serializeQueue(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => tokenText(entry));
}

// A list that may hold tokens or entries, read back as tokens: the state a
// reply prints is the parsed queue, and this is how it is rendered.
function tokenList(values) {
  return (Array.isArray(values) ? values : []).map((value) => (
    typeof value === "string" ? value : tokenText(value)
  ));
}

// Where a rock sits in the queue: the index of the first entry it matches, so
// the entry at the top of the list is mined before the ones under it. -1 means
// nothing in the queue wants this rock and the caller applies filterFallback.
function rank(entries, scope, name, typeID) {
  if (!Array.isArray(entries)) {
    return 0;
  }
  const haystack = String(name || "").toLowerCase();
  const numericTypeID = String(Number.isFinite(Number(typeID)) ? Math.trunc(Number(typeID)) : 0);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind && entry.kind !== scope) {
      continue;
    }
    if (entry.pattern === "*") {
      return index;
    }
    if (NUMBER_SHAPE.test(entry.pattern)) {
      if (entry.pattern === numericTypeID) {
        return index;
      }
      continue;
    }
    if (haystack.includes(entry.pattern)) {
      return index;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Cutting a typed line into entries
//
// The separator is the comma, so a name that holds a space survives:
// "/atm filter add gneiss, dark ochre" is two entries. A line with no comma is
// still cut at the spaces, but a run of words that together name a rock of the
// game is put back together first - which is what keeps "dark ochre" one entry
// instead of "dark" and "ochre", two patterns that each match something on
// their own and so never reached the warning line that exists for a name
// nothing matches. "azure ice" travels the same way, which is the reason a kind
// word is allowed to be part of a name.
//
// A comma is never crossed: "dark, ochre" is two entries on purpose. A number is
// a word of its own and never joins a neighbour, because a number is a type ID.
// ---------------------------------------------------------------------------

// Can this word be part of a name of several words? A number cannot - it is a
// type ID - and neither can a word that cannot be an entry at all.
function canJoinName(word) {
  const text = toStringValue(word).toLowerCase();
  if (!text || text === "," || NUMBER_SHAPE.test(text)) {
    return false;
  }
  return parseTypedToken(text) !== null;
}

// Does this text name a rock the game knows? Asked through the same catalogue
// the replies group by, so a server whose item types cannot be read joins
// nothing and the line is cut at the spaces exactly as it was before.
function namesARock(text, kindsOf) {
  if (typeof kindsOf !== "function") {
    return false;
  }
  const entry = parseTypedToken(text);
  if (!entry) {
    return false;
  }
  const kinds = kindsOf(entry.pattern);
  return Array.isArray(kinds) && kinds.length > 0;
}

// One comma-free run of words, cut back into entries: the longest run that
// names a rock wins ("dark ochre"), everything else is one word at a time.
function joinRockNames(words, kindsOf) {
  const chunks = [];
  let index = 0;
  while (index < words.length) {
    let taken = 1;
    if (canJoinName(words[index])) {
      for (let end = words.length; end > index + 1; end -= 1) {
        const run = words.slice(index, end);
        if (run.every(canJoinName) && namesARock(run.join(" "), kindsOf)) {
          taken = end - index;
          break;
        }
      }
    }
    chunks.push(words.slice(index, index + taken).join(" "));
    index += taken;
  }
  return chunks;
}

// The words of a typed line as the entries they ask for. This is the one place
// a command's spelling is read, which is what keeps a reply printable back into
// the command that produced it.
function splitTypedWords(text, kindsOf) {
  const words = String(text == null ? "" : text)
    .replace(/,/gu, " , ")
    .split(/\s+/u)
    .filter(Boolean);
  const chunks = [];
  let group = [];
  const closeGroup = () => {
    if (group.length > 0) {
      chunks.push(...joinRockNames(group, kindsOf));
      group = [];
    }
  };
  for (const word of words) {
    if (word === ",") {
      closeGroup();
      continue;
    }
    group.push(word);
  }
  closeGroup();
  return chunks;
}

// The words of a command sorted into what a command may do with them: an entry
// it can place, a word that names a whole kind of rock and has to be refused, a
// 1.2.5 pin that no longer exists, or a word that cannot be an entry at all.
// Every filter command reads its arguments through this one function, so all of
// them refuse the same words with the same words.
function classifyTypedWords(words) {
  const usable = [];
  const reserved = [];
  const pinned = [];
  const unusable = [];
  for (const word of words) {
    const text = toStringValue(word).toLowerCase();
    if (!text) {
      continue;
    }
    if (pinnedTokenKind(text)) {
      pinned.push(text);
      continue;
    }
    if (isReservedWord(text)) {
      reserved.push(text);
      continue;
    }
    if (!parseTypedToken(text)) {
      unusable.push(text);
      continue;
    }
    usable.push(text);
  }
  return { usable, reserved, pinned, unusable };
}

// ---------------------------------------------------------------------------
// Editing the queue
//
// A reply prints the queue grouped by the kind of rock each entry mines, and the
// number in front of an entry counts inside that entry's own list: the first ore
// is 1 and so is the first ice. "move" therefore reads a name and, right after
// it, the position that name should take in its own list; "add" only appends,
// and "del" takes names and drops everything they resolve to.
// ---------------------------------------------------------------------------

// One edit per "name [position]" pair. Positions are read only where a command
// takes them - "move" - so a number typed after a name in "add" stays what it
// is everywhere else: a type ID.
function parseEdits(words, options = {}) {
  const withPositions = options.positions === true;
  const edits = [];
  let open = null;
  for (const word of words) {
    const text = toStringValue(word).toLowerCase();
    if (!text) {
      continue;
    }
    if (withPositions && open && NUMBER_SHAPE.test(text)) {
      open.position = Number(text);
      open = null;
      continue;
    }
    const entry = parseTypedToken(text);
    if (!entry) {
      edits.push({ token: text, entry: null, position: null });
      open = null;
      continue;
    }
    open = { token: tokenText(entry), entry, position: null };
    edits.push(open);
  }
  return edits;
}

// Which kinds of rock one entry can mine, as lib/runtime.js knows them: a pinned
// entry answers for itself, "*" stands for every kind, and a name the caller
// cannot place answers with nothing - which is also how a mistyped name stays
// out of every list.
function kindsOfEntry(entry, kindsOf) {
  if (entry.kind) {
    return [entry.kind];
  }
  if (entry.pattern === "*") {
    return ORE_FILTER_SCOPES.slice();
  }
  const kinds = typeof kindsOf === "function" ? kindsOf(tokenText(entry)) : null;
  return Array.isArray(kinds) ? kinds : [];
}

// Where the entries of one kind sit in the flat queue, in queue order.
function kindIndexes(queue, kind, kindsOf) {
  const indexes = [];
  queue.forEach((entry, index) => {
    if (kindsOfEntry(entry, kindsOf).includes(kind)) {
      indexes.push(index);
    }
  });
  return indexes;
}

// A 1-based position inside a list that ends up "size" entries long.
function clampSlot(position, size) {
  if (position < 1) {
    return 1;
  }
  return position > size ? size : position;
}

// The queue with every edit placed. A position counts inside the list of the
// kind the entry mines - the number the reply prints next to it - and whatever
// used to sit there shifts along. A position past the end of that list lands at
// its end, which is why "move zeolites 5" on the only moon ore leaves it where
// it is; for the same reason a move that asks for the place an entry already
// has changes nothing. An edit with no position joins the end of its own list
// ("move"), or the end of the queue ("add"), and so does an entry that mines no
// rock, or every rock, because it has no list to count in. onlyExisting is what
// makes "move" report a name that is not queued yet instead of adding it, and
// makes "move" report a name that is not queued yet instead of adding it, and
// onlyKind is what makes it edit one list and pass over the rest. skipExisting is
// what makes "add" leave an entry that is already queued exactly where it is:
// adding a rock twice never reorders the list.
function placeTokens(tokens, edits, kindsOf, options = {}) {
  const queue = parseEntries(Array.isArray(tokens) ? tokens : []);
  const placed = [];
  const missed = [];
  const rejected = [];
  const discarded = [];
  const skipped = [];
  const onlyKind = ORE_FILTER_SCOPES.includes(options.onlyKind) ? options.onlyKind : null;
  for (const edit of edits) {
    const entry = edit.entry || parseTypedToken(edit.token);
    if (!entry) {
      rejected.push(String(edit.token));
      continue;
    }
    const token = tokenText(entry);
    const kinds = kindsOfEntry(entry, kindsOf);
    // "move" edits the list the first name typed belongs to, and only that one:
    // an entry of another kind is reported rather than dropped in silently. A
    // name the catalogue cannot place has no kind to disagree with, so it falls
    // through and is reported as missing instead.
    if (onlyKind && kinds.length > 0 && !kinds.includes(onlyKind)) {
      discarded.push(token);
      continue;
    }
    const current = queue.findIndex((existing) => sameEntry(existing, entry));
    if (current < 0 && options.onlyExisting) {
      missed.push(token);
      continue;
    }
    // "add" leaves what is already queued where it is: the entry keeps the place
    // it has, and the reply names it as already in the list.
    if (current >= 0 && options.skipExisting) {
      skipped.push(token);
      continue;
    }
    const kind = kinds.length === 1 ? kinds[0] : null;
    const wanted = Number.isInteger(edit.position) && edit.position >= 1 ? edit.position : null;
    let at = null;
    if (kind) {
      const indexes = kindIndexes(queue, kind, kindsOf);
      const here = current < 0 ? 0 : indexes.indexOf(current) + 1;
      const size = indexes.length + (current < 0 ? 1 : 0);
      const slot = wanted !== null ? clampSlot(wanted, size) : (options.groupEnd ? size : null);
      if (slot === null) {
        at = queue.length;
      } else if (slot === here) {
        placed.push(token);
        continue;
      } else {
        if (current >= 0) {
          queue.splice(current, 1);
        }
        const rest = kindIndexes(queue, kind, kindsOf);
        at = slot <= rest.length
          ? rest[slot - 1]
          : (rest.length > 0 ? rest[rest.length - 1] + 1 : queue.length);
      }
    } else {
      if (current >= 0) {
        queue.splice(current, 1);
      }
      at = queue.length;
    }
    queue.splice(at, 0, entry);
    placed.push(token);
  }
  return { tokens: serializeQueue(queue), placed, skipped, missed, rejected, discarded };
}

// "del": everything a typed word resolves to leaves the queue. A kind word
// ("ore", "ice", "moon") drops that whole list and "*" drops everything - only a
// file can store one of those, which is why "clear" is the command that reaches
// for the kind branch - and a name or a type ID drops the entries it matches:
// the token itself, the rock name inside a pinned token ("glacial" finds
// "ice:glacial mass"), or the type ID a name stands for.
function removeMatching(tokens, words, kindsOf) {
  let queue = parseEntries(Array.isArray(tokens) ? tokens : []);
  const removed = [];
  const missed = [];
  for (const word of words) {
    const text = toStringValue(word).toLowerCase();
    if (!text) {
      continue;
    }
    const typed = parseStoredToken(text);
    if (!typed) {
      missed.push(text);
      continue;
    }
    const typedKind = typed.kind !== null && typed.pattern === "*" ? typed.kind : null;
    const keep = [];
    let hit = false;
    for (const entry of queue) {
      const drop = typedKind
        ? kindsOfEntry(entry, kindsOf).includes(typedKind)
        : typed.pattern === "*"
          || (entry.pattern === typed.pattern
            && (typed.kind === null || kindsOfEntry(entry, kindsOf).includes(typed.kind)))
          || (typed.kind === null
            && !NUMBER_SHAPE.test(typed.pattern)
            && tokenText(entry).includes(typed.pattern));
      if (drop) {
        removed.push(entry);
        hit = true;
      } else {
        keep.push(entry);
      }
    }
    queue = keep;
    if (!hit) {
      missed.push(text);
    }
  }
  return { tokens: serializeQueue(queue), removed: serializeQueue(removed), missed };
}

// The queue read grouped by the kind of rock each entry mines, for the reply
// that answers "in which order do I mine ore, then ice, then moon", and with
// the number each entry shows inside its own list. kindsOf is what
// lib/oreNames.js knows about a name; an entry it cannot place is reported
// apart, which is also how a mistyped name shows up.
function groupByKind(tokens, kindsOf) {
  const groups = {};
  for (const scope of ORE_FILTER_SCOPES) {
    groups[scope] = [];
  }
  const unknown = [];
  for (const token of tokenList(tokens)) {
    const kinds = typeof kindsOf === "function" ? kindsOf(token) : [];
    if (!Array.isArray(kinds) || kinds.length === 0) {
      unknown.push({ order: unknown.length + 1, token });
      continue;
    }
    for (const scope of kinds) {
      if (groups[scope]) {
        groups[scope].push({ order: groups[scope].length + 1, token });
      }
    }
  }
  return { groups, unknown };
}

// How an entry reads in a reply: the token itself, plus what it stands for when
// a token on its own would not say it. Only a queue written by an older release
// can hold one of those tokens now.
function describeToken(token) {
  const entry = parseStoredToken(token);
  if (entry && entry.pattern === "*") {
    return entry.kind ? `${token} (any ${entry.kind} rock)` : `${token} (any rock)`;
  }
  return String(token);
}

module.exports = {
  tokenList,
  classifyTypedWords,
  describeToken,
  groupByKind,
  isAnyWord,
  isKindWord,
  isReservedWord,
  kindIndexes,
  kindsOfEntry,
  parseEdits,
  parseStoredToken,
  parseTypedToken,
  pinnedTokenKind,
  placeTokens,
  rank,
  readQueue,
  removeMatching,
  serializeQueue,
  splitTypedWords,
  tokenText,
};