// Rwanda's 30 districts by province. Agents are appointed per district and farmers are assigned by district
// (contracts/PolicyDesk.sol stores the upper-case name as bytes32). CommonJS: used by the USSD service and the portal.
const PROVINCES = [
  ["Kigali City", ["Gasabo", "Kicukiro", "Nyarugenge"]],
  ["Northern", ["Burera", "Gakenke", "Gicumbi", "Musanze", "Rulindo"]],
  ["Southern", ["Gisagara", "Huye", "Kamonyi", "Muhanga", "Nyamagabe", "Nyanza", "Nyaruguru", "Ruhango"]],
  ["Eastern", ["Bugesera", "Gatsibo", "Kayonza", "Kirehe", "Ngoma", "Nyagatare", "Rwamagana"]],
  ["Western", ["Karongi", "Ngororero", "Nyabihu", "Nyamasheke", "Rubavu", "Rusizi", "Rutsiro"]],
];
const DISTRICTS = PROVINCES.flatMap(([, ds]) => ds);
const code = (name) => String(name).toUpperCase(); // as stored on-chain (bytes32 string)
const titleOf = (c) => DISTRICTS.find((d) => code(d) === String(c).toUpperCase()) || c;

module.exports = { PROVINCES, DISTRICTS, code, titleOf };
