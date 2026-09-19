"use strict";

// The grade a rock's own type name declares.
//
// The game spawns the same ore at several qualities and the type name is where
// that shows: the bare name is grade I, and "II-Grade", "III-Grade", "IV-Grade"
// and "X-Grade" sit above it. "0-Grade" is the one below, at half the yield of
// the plain rock. Only Veldspar, Scordite and Pyroxeres, together with their
// compressed forms, have a 0-Grade; 232 of the 503 asteroid types carry a
// "-Grade" marker at all.
//
// The ladder is real, which is why this is worth reading: the refined output of
// 100 units, straight out of the live item types (getTypeMaterials), is 200 for
// Veldspar 0-Grade, 400 for the bare rock, 420 at II-Grade, 440 at III-Grade and
// 460 at IV-Grade; Blue Ice gives 69 against 104 for Blue Ice IV-Grade, and the
// moon families that grade at all go up to X-Grade. So "higher number, better
// rock" holds everywhere a "-Grade" is printed.
//
// The prefix matters for nothing here - Compressed and Ancient Compressed
// Veldspar IV-Grade is the same rock as Veldspar IV-Grade - so it is taken off
// before the marker is read.
const COMPRESSED_PREFIX = /^(?:ancient |batch )?compressed /iu;
// Longest marker first, so "iv" and "ix" cannot be read as a single "i".
const GRADE_SUFFIX = /^(.*?)\s*(viii|vii|iii|ii|iv|ix|vi|xi|0|i|v|x)-grade$/iu;
const GRADE_MARKS = Object.freeze({
  0: 0,
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
});

// The grade of a rock whose type name has no marker: the bare name is grade I.
const BASE_GRADE = 1;

// The grade of one rock type name. A name that does not end in a marker the game
// uses is the plain rock, so a rock this does not know about is never ranked
// above or below its neighbours by accident.
function gradeOf(name) {
  const text = String(name == null ? "" : name).replace(COMPRESSED_PREFIX, "").trim();
  const match = GRADE_SUFFIX.exec(text);
  if (!match) {
    return BASE_GRADE;
  }
  const mark = GRADE_MARKS[match[2].toLowerCase()];
  return mark === undefined ? BASE_GRADE : mark;
}

module.exports = {
  BASE_GRADE,
  GRADE_MARKS,
  gradeOf,
};