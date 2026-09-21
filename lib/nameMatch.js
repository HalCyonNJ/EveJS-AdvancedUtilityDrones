"use strict";

// How wrong a spelling may be, in the one place the mod decides it.
//
// "/aud copy exampel" finds "Example Miner", and "/aud mining filter add veldsparx" is
// answered with "did you mean Veldspar?". Both use the rule below: a query may
// differ from a name by at most two edits and never by more than a third of
// what was typed. Two edits is what a missing or a doubled letter costs; the
// third keeps a short query from dragging in every name in the file.

function normalizeName(value) {
  return String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/gu, " ");
}

// The single-character edits between two strings: how many insertions,
// deletions and substitutions turn one into the other. Names are short and
// there are only ever a handful of them to check, so the plain table is plenty.
function editDistance(left, right) {
  const previous = [];
  const current = [];
  for (let index = 0; index <= right.length; index += 1) {
    previous[index] = index;
  }
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
    }
    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = current[column];
    }
  }
  return previous[right.length];
}

function typoBudget(query) {
  return Math.min(2, Math.floor(normalizeName(query).length / 3));
}

// The nearest names a query could have meant, closest first: the caller prints
// at most a couple of them, so the list is capped by maxResults.
function nearestNames(query, candidates, maxResults = 3) {
  const wanted = normalizeName(query);
  const budget = typoBudget(wanted);
  if (!wanted || budget <= 0) {
    return [];
  }
  const found = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const name = normalizeName(candidate);
    if (!name || Math.abs(name.length - wanted.length) > budget) {
      continue;
    }
    const distance = editDistance(name, wanted);
    if (distance <= budget) {
      found.push({ name: String(candidate), distance });
    }
  }
  found.sort((left, right) => (
    left.distance - right.distance || left.name.localeCompare(right.name)
  ));
  return found.slice(0, Math.max(0, maxResults));
}

module.exports = {
  editDistance,
  nearestNames,
  normalizeName,
  typoBudget,
};