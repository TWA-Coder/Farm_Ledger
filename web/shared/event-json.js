// Contract event arguments as JSON. BigInt values (amounts, ids, timestamps) do not survive JSON.stringify, so they
// travel as {"$big": "123"} and are turned back into BigInt on the other side. Used by the server-side indexer and
// by the portal, so both agree on the format.
function encodeArgs(fragment, args) {
  const out = {};
  fragment.inputs.forEach((input, i) => {
    const v = args[i];
    out[input.name || String(i)] = typeof v === "bigint" ? { $big: v.toString() } : v;
  });
  return out;
}

function reviveArgs(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v;
  return out;
}

module.exports = { encodeArgs, reviveArgs };
