"use strict";

// The identifier grammar behind "/atm copy".
//
// A multibox mining fleet wants identical settings on every account, and
// retyping a filter queue on four alts is how a fleet ends up mining four
// different rocks. "/atm copy <who>" takes another character's stored entry out
// of the players file and writes it onto the caller, so the two are identical
// afterwards.
//
// "<who>" is any of:
//   140000005        the character ID, which is what keys the players file
//   User:140000005   the same ID with the label the client puts in front of it
//   Example Miner     the character name the mod stored when that player last
//                    changed something
// A name is matched exactly first, then as a unique prefix, then as a unique
// substring, and last with every word of the query somewhere in the name, so
// "/atm copy example", "/atm copy miner example" and a half-remembered spelling
// all find the character. A query that could mean two characters is refused
// with the candidates instead of guessed.
//
// Only a character who has an entry of their own can be a source: a character
// who never changed anything has nothing to copy, and "/atm reset" already
// means "put me back on the server defaults". The settings are not private -
// every entry sits in the same server-side file - so copying from another
// player is allowed by default, and
// EVEJS_ALT_MINING_DRONES_ALLOW_PLAYER_COPY=0 removes the command entirely.

// How far off a spelling may be is decided in one place, lib/nameMatch.js,
// because the ore filter asks the same question about a rock name.
const { editDistance, normalizeName, typoBudget } = require("./nameMatch.js");

// The labels a player may put in front of an identifier. "User:" is what the
// client shows, the rest are there so nobody has to remember which one it is.
const COPY_LABELS = Object.freeze(["user", "id", "char", "character", "pilot", "name"]);

// Enough lines for a fleet, without turning the reply into a wall of text.
const MAX_COPY_LIST_LINES = 10;

// Everything the players file stores next to a character's real settings.
const META_FIELDS = Object.freeze(["updatedAt", "characterName", "_comment"]);

// "User:140000005" -> { raw: "140000005" }; "140000005" -> { raw: "140000005" };
// nothing to copy -> null, which is what prints the list of sources instead.
function parseCopyTarget(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) {
    return null;
  }
  const separator = raw.indexOf(":");
  if (separator > 0 && COPY_LABELS.includes(normalizeName(raw.slice(0, separator)))) {
    const rest = raw.slice(separator + 1).trim();
    return rest ? { raw: rest } : null;
  }
  return { raw };
}

// entries is the players file as { "<characterID>": { characterName, ... } }.
// Every character whose stored name answers to the query, from the tightest
// tier that answers at all: exact, then prefix, then substring, then every word
// of the query somewhere in the name - in any order - and last with one or two
// edits allowed per word, so "exampel" and "miner example" both land. A number is
// the character ID the players file is keyed by.
//
// [] means nobody matches; one ID is a character the query names; more than one
// is for the caller to report rather than guess between. "/atm copy list"
// wants them all, "/atm copy <who>" wants exactly one, and both read the query
// the same way.
function matchStoredCharacters(entries, raw) {
  const source = entries && typeof entries === "object" ? entries : {};
  const wanted = normalizeName(raw);
  if (!wanted) {
    return [];
  }
  if (/^\d+$/u.test(wanted)) {
    const key = String(Number(wanted));
    return source[key] ? [Number(key)] : [];
  }
  const ids = Object.keys(source).sort((left, right) => Number(left) - Number(right));
  const nameOf = (id) => normalizeName(source[id] && source[id].characterName);
  const words = wanted.split(" ").filter(Boolean);
  const attempts = [
    (id) => nameOf(id) === wanted,
    (id) => nameOf(id).startsWith(wanted),
    (id) => nameOf(id).includes(wanted),
  ];
  if (words.length > 1) {
    // "miner example" finds "Example Miner": every word has to be in the name,
    // but the order they were typed in does not matter.
    attempts.push((id) => words.every((word) => nameOf(id).includes(word)));
  }
  const budget = typoBudget(wanted);
  if (budget > 0) {
    // A misspelling: every word of the query is either in the name or one or
    // two edits away from a word of it, so "exampel" and "fleet leda" both land.
    attempts.push((id) => {
      const name = nameOf(id);
      const nameWords = name.split(" ");
      return words.every((word) => (
        name.includes(word) ||
        (word.length >= 3 && nameWords.some((nameWord) => (
          nameWord.length >= 4 && editDistance(nameWord, word) <= budget
        )))
      ));
    });
  }
  for (const attempt of attempts) {
    const matches = ids.filter(attempt);
    if (matches.length > 0) {
      return matches.map((id) => Number(id));
    }
  }
  return [];
}

// One source for "/atm copy <who>": { characterID, entry } or
// { error: "not-found" | "ambiguous", candidates: ["<id>", ...] }.
function matchCopySource(entries, raw) {
  const source = entries && typeof entries === "object" ? entries : {};
  const matches = matchStoredCharacters(source, raw);
  if (matches.length === 0) {
    return { error: "not-found", candidates: [] };
  }
  if (matches.length > 1) {
    return { error: "ambiguous", candidates: matches.map((id) => String(id)) };
  }
  return { characterID: matches[0], entry: source[String(matches[0])] };
}

// An entry can exist and still hold nothing to copy: the mod writes the
// character name next to the settings, a hand-written file may contain the name
// alone, and /atm reset removes the entry altogether.
function hasCopyableSettings(entry) {
  return Object.keys(entry || {}).some((field) => !META_FIELDS.includes(field));
}

module.exports = {
  COPY_LABELS,
  META_FIELDS,
  MAX_COPY_LIST_LINES,
  hasCopyableSettings,
  matchCopySource,
  matchStoredCharacters,
  normalizeName,
  parseCopyTarget,
};