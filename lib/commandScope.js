"use strict";

// Shared re-entrancy guard for the drone commands.
//
// The loader wraps droneRuntime.commandMineRepeatedly / commandReturnBay so the
// mod can tell a player's order ("the player is flying this drone by hand, back
// off") from the order this mod just issued itself. Both directions go through
// the same exported function, so the mod marks its own calls with a counter
// that both modules share.
let depth = 0;

function run(fn) {
  depth += 1;
  try {
    return fn();
  } finally {
    depth -= 1;
  }
}

function isInternal() {
  return depth > 0;
}

module.exports = {
  isInternal,
  run,
};