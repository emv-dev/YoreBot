import { getSignedReleaseUrl } from "./signed-release-url.mjs";

const benefits = [
  {
    number: "01",
    title: "Chat privately",
    copy: "Conversations run on your computer, so everyday questions stay close to home.",
  },
  {
    number: "02",
    title: "Organize Downloads",
    copy: "YoreBot inventories the folder and proposes a plan before it creates or moves anything.",
  },
  {
    number: "03",
    title: "Approve every change",
    copy: "See the exact source and destination. Choose Allow once, or deny it and nothing changes.",
  },
] as const;

export default function Home() {
  const signedReleaseUrl = getSignedReleaseUrl();

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="site-header">
        <a className="brand" href="#main-content" aria-label="YoreBot home">
          <span className="brand-mark" aria-hidden="true" />
          <span>YoreBot</span>
        </a>
        <p className="release-chip">
          <span aria-hidden="true" /> Windows
        </p>
      </header>

      <main id="main-content">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Private help, on your computer</p>
            <h1 id="hero-title">Your computer. Your files. Your say.</h1>
            <p className="hero-lede">
              Chat privately. Get help organizing Downloads. Nothing moves
              until you approve the exact change.
            </p>

            {signedReleaseUrl ? (
              <a className="primary-action" href={signedReleaseUrl}>
                Download for Windows
                <span aria-hidden="true">↘</span>
              </a>
            ) : (
              <div className="signing-status" role="status">
                <span className="status-mark" aria-hidden="true" />
                <span>
                  <strong>Windows release is being signed.</strong>
                  The download will appear here when it is ready.
                </span>
              </div>
            )}
          </div>

          <figure className="approval-demo">
            <div className="window-bar" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="demo-body">
              <p className="demo-label">Downloads</p>
              <div className="message user-message">Organize this folder.</div>
              <div className="message bot-message">
                I found one document. Here is the exact change:
              </div>
              <div className="approval-card">
                <p>Create folder</p>
                <strong>Downloads / Documents</strong>
                <p>Move</p>
                <strong>invoice.pdf → Documents / invoice.pdf</strong>
                <div className="approval-actions" aria-hidden="true">
                  <span>Deny</span>
                  <span>Allow once</span>
                </div>
              </div>
            </div>
            <figcaption>
              You see exactly what will change before YoreBot can change it.
            </figcaption>
          </figure>
        </section>

        <section className="benefits" aria-labelledby="benefits-title">
          <div className="section-heading">
            <p className="eyebrow">Simple by design</p>
            <h2 id="benefits-title">Useful without the control panel.</h2>
          </div>
          <div className="benefit-grid">
            {benefits.map((benefit) => (
              <article className="benefit-card" key={benefit.number}>
                <p className="benefit-number" aria-hidden="true">
                  {benefit.number}
                </p>
                <h3>{benefit.title}</h3>
                <p>{benefit.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <div>
            <p className="eyebrow">YoreBot for Windows</p>
            <h2 id="closing-title">
              {signedReleaseUrl
                ? "The signed installer is ready."
                : "A careful release is worth the wait."}
            </h2>
          </div>
          <p>
            {signedReleaseUrl
              ? "Use the download above to get YoreBot."
              : "We are signing the Windows release before offering it here."}
          </p>
        </section>
      </main>

      <footer>
        <span>YoreBot</span>
        <span>Private help that asks first.</span>
      </footer>
    </>
  );
}
