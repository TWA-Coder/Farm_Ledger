import "./landing.css";

export const metadata = {
  title: "FarmLedger · Farm insurance for Rwanda",
  description: "Crop and cattle insurance for Rwandan smallholder farmers, with payouts decided by clear written rules.",
};

const JOURNEY = [
  ["Register", "Your National ID and phone number. Nothing else."],
  ["Add your farm", "A plot with its district and crop, or a cow with its ear tag number."],
  ["Choose cover and pay", "Pick the level of rain or crop health that triggers a payout, and the dates your cover starts and ends. You see the full price before you pay, and fees are covered for you."],
  ["We watch the risk", null, "Weather and satellite readings for your plot are checked during the season.", "If the cow dies, you report it with a photo, on the website or from a basic phone."],
  ["The rule is checked", null, "The reading is compared with the rule written in your policy. No inspector has to visit.", "Certified veterinarians review the claim. Enough of them must confirm it."],
  ["You are paid", "The amount insured is paid to your account and you get an SMS. You can follow every step online or by phone."],
];

const COVERS = [
  ["Drought cover", "Crop plots", "Pays when rain on your plot over 30 days falls below the level written in the policy."],
  ["Flood cover", "Crop plots", "Pays when rain on your plot over 30 days goes above the level written in the policy."],
  ["Crop health cover", "Crop plots", "Pays when satellite images show your crop is not growing well (low vegetation index)."],
  ["Cattle cover", "One cow per policy", "Pays when the cow dies during the cover period and certified veterinarians confirm it."],
];

export default function Landing() {
  return (
    <div className="lp">
      <header className="lp-top">
        <div className="lp-wrap lp-bar">
          <a className="lp-logo" href="/"><span aria-hidden="true">FL</span>FarmLedger</a>
          <nav aria-label="Page sections">
            <a href="#how">How it works</a>
            <a href="#covers">Cover</a>
            <a href="#about">About</a>
            <a className="lp-btn sm" href="/app">Get started</a>
          </nav>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-grid">
            <div>
              <p className="lp-kicker">Crop and cattle insurance for Rwandan farmers</p>
              <h1>Protect your harvest and your cattle, with rules you can read before you pay.</h1>
              <p className="lp-lead">
                If the rains fail on your plot, your crop cover pays automatically from weather readings.
                If an insured cow dies, certified veterinarians confirm it and you are paid. You can see where
                your policy or claim stands at any time, on a smartphone or a basic phone.
              </p>
              <div className="lp-ctas">
                <a className="lp-btn" href="/app">Get started</a>
                <a className="lp-btn ghost" href="#how">How it works</a>
                <a className="lp-link" href="#about">Learn about FarmLedger</a>
              </div>
            </div>
            <figure className="lp-photo">
              <img src="/images/farm.jpg" alt="A maize field in front of green, rolling farmland in Rwanda" width="678" height="452" />
            </figure>
          </div>
        </section>

        <section className="lp-sec" id="problem">
          <div className="lp-wrap lp-two">
            <h2>The problem we are working on</h2>
            <div>
              <p>For a smallholder family, one dry season or the loss of a dairy cow can take away a year of income.</p>
              <p>
                Insurance can help, but claims usually depend on paperwork, field inspections and office visits. Under the
                standard farm insurance contracts in Rwanda, the insurer has up to 30 days to pay after every document has
                been submitted, and it is hard for a farmer to see where a claim stands in the meantime.
              </p>
              <p>FarmLedger tests a simpler way: write the payout rule into the policy, check it with data or with certified vets, and pay as soon as the rule is met.</p>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-alt" id="how">
          <div className="lp-wrap">
            <h2>How it works</h2>
            <p className="lp-sub">Six steps from registration to payout. Crops and cattle differ only in how a loss is checked.</p>
            <ol className="lp-journey">
              {JOURNEY.map(([title, text, crop, cattle], i) => (
                <li key={title}>
                  <span className="lp-num" aria-hidden="true">{i + 1}</span>
                  <div>
                    <h3>{title}</h3>
                    {text ? <p>{text}</p> : (
                      <dl className="lp-lanes">
                        <div><dt>Crops</dt><dd>{crop}</dd></div>
                        <div><dt>Cattle</dt><dd>{cattle}</dd></div>
                      </dl>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="lp-sec" id="covers">
          <div className="lp-wrap">
            <h2>Cover you can choose</h2>
            <p className="lp-sub">The exact levels, prices and lengths are shown in the portal before you apply.</p>
            <div className="lp-table" role="region" aria-label="Cover types" tabIndex={0}>
              <table>
                <thead><tr><th scope="col">Cover</th><th scope="col">For</th><th scope="col">When it pays</th></tr></thead>
                <tbody>{COVERS.map(([n, f, w]) => <tr key={n}><th scope="row">{n}</th><td>{f}</td><td>{w}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-alt" id="benefits">
          <div className="lp-wrap">
            <h2>What is different for the farmer</h2>
            <ul className="lp-points">
              <li><b>The rule is written down before you pay.</b> Each policy states exactly when it pays. Nobody can change it afterwards.</li>
              <li><b>The money is set aside.</b> When you buy cover, the insurer's funds for your full payout are reserved and cannot be used for anything else.</li>
              <li><b>No waiting for an inspector on crop cover.</b> When a reading meets the rule, the payout happens in the same step.</li>
              <li><b>Works on a basic phone.</b> Check your policies, report a cow's death and follow a claim by USSD.</li>
              <li><b>Every step is on record.</b> Purchases, readings, vet decisions and payouts are kept in a record that anyone can check.</li>
            </ul>
          </div>
        </section>

        <section className="lp-sec" id="about">
          <div className="lp-wrap lp-two">
            <h2>About FarmLedger</h2>
            <div>
              <p>
                FarmLedger is parametric micro-insurance for smallholder farmers in Rwanda, designed and built by Arsene Karuretwa. It is built for
                farmers and cooperatives, for the veterinarians who confirm cattle claims, and for insurers who want to settle
                claims faster and at lower cost.
              </p>
              <p>
                Behind the scenes, policies and payments are kept on a blockchain: a shared record that can be checked by anyone
                and cannot be edited after the fact. Farmers do not need to know how it works to use it.
              </p>
              <figure className="lp-author">
                <img src="/images/author.jpg" alt="Arsene Karuretwa" width="560" height="720" loading="lazy" />
                <figcaption><b>Arsene Karuretwa</b><span>Creator of FarmLedger</span></figcaption>
              </figure>
              <h3>Where FarmLedger stands today</h3>
              <ul className="lp-plain">
                <li>FarmLedger is not yet offered through a licensed insurer, so premiums and payouts in the portal use demonstration funds.</li>
                <li>Weather readings are simulated unless the oracle is switched to real NASA POWER rainfall. The portal labels every reading as real or sample data. Crop health (NDVI) readings are always samples for now.</li>
                <li>SMS and Mobile Money payments are simulated. Real SMS can be switched on with an Africa's Talking account.</li>
                <li>Some terms of the standard NAIS contracts are not included yet, such as the 40% government share of the premium and the excess.</li>
              </ul>
              <div className="lp-ctas">
                <a className="lp-btn" href="/app">Open the portal</a>
                <a className="lp-btn ghost" href="/ussd">Try the basic phone menu</a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-bar">
          <span>© 2026 FarmLedger · Arsene Karuretwa</span>
          <nav aria-label="Footer"><a href="/app">Portal</a><a href="/ussd">USSD simulator</a><a href="#how">How it works</a></nav>
        </div>
      </footer>
    </div>
  );
}
