// Form validation for the farmer screens. CommonJS so the Hardhat tests can exercise it directly.
const RWANDA = { latMin: -2.85, latMax: -1.04, lonMin: 28.85, lonMax: 30.9 };

function validateRegistration(nid, phone) {
  const e = {};
  if (!/^\d{16}$/.test(String(nid))) e.nid = "A Rwandan National ID has 16 digits.";
  if (!/^2507\d{8}$/.test(String(phone))) e.phone = "Enter the number as 2507 followed by 8 digits, for example 250788123456.";
  return e;
}

function validatePlot(f) {
  const e = {};
  const lat = Number(f.lat), lon = Number(f.lon), area = Number(f.ha);
  if (f.lat === "" || f.lat == null || !Number.isFinite(lat) || lat < RWANDA.latMin || lat > RWANDA.latMax) e.lat = "Latitude must be inside Rwanda (between -2.85 and -1.04).";
  if (f.lon === "" || f.lon == null || !Number.isFinite(lon) || lon < RWANDA.lonMin || lon > RWANDA.lonMax) e.lon = "Longitude must be inside Rwanda (between 28.85 and 30.90).";
  if (!Number.isFinite(area) || area <= 0 || area > 1000) e.ha = "Enter the plot size in hectares (more than 0, at most 1,000).";
  return e;
}

function validateAnimal(f, year = new Date().getFullYear()) {
  const e = {};
  const tag = String(f.tag || "").trim();
  if (!tag) e.tag = "Enter the ear tag (RFID) number.";
  else if (!/^[A-Za-z0-9-]{3,31}$/.test(tag)) e.tag = "Use 3 to 31 letters, numbers or dashes, exactly as printed on the tag.";
  const y = Number(f.year);
  if (!Number.isInteger(y) || y < year - 25 || y > year) e.year = `Enter a birth year between ${year - 25} and ${year}.`;
  return e;
}

module.exports = { RWANDA, validateRegistration, validatePlot, validateAnimal };
