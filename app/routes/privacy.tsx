import type { MetaFunction } from "react-router";

import {
  LegalLayout,
  SupportEmail,
  legalLinks,
  legalMeta,
  legalStyles as s,
} from "../components/legal/LegalLayout";
import { ERASURE_WINDOW } from "../components/legal/copy";
import { BRAND, LEGAL_UPDATED, PAGES } from "../lib/brand";

/*
 * Every statement here must match what the code and the server actually do (see the privacy
 * fact sheet in the launch audit). Update this page, and LEGAL_UPDATED, before adding a new
 * provider (for example Cloudflare R2 or RunPod) or changing a retention period.
 */

export const meta: MetaFunction = () =>
  legalMeta(
    "Privacy policy",
    `How ${BRAND.name} handles data from Shopify merchants who use the app and from visitors to this website: what we collect, why, where it's stored, how long we keep it and your rights.`,
    PAGES.privacy,
  );

export const links = legalLinks;

const summary = (
  <div className={s.callout}>
    <h2>The short version</h2>
    <ul>
      <li>
        The Shopify app only asks for access to your products and files. It
        never reads your orders or customers.
      </li>
      <li>
        Your images are used only to clean them, show you the result and keep a
        backup you can restore. We don&apos;t sell data, and we never use your
        images to train AI models.
      </li>
      <li>
        Your store&apos;s data and images are stored on one server in the
        Netherlands (EU), and most photos are processed there too. Only some
        photos go to Replicate in the US (a harder cut-out, or AI upscaling),
        which gets the image pixels only and deletes them after an hour by
        default.
      </li>
      <li>
        Uninstall the app and your store&apos;s data is erased {ERASURE_WINDOW}.
      </li>
      <li>No analytics, advertising or tracking cookies.</li>
    </ul>
  </div>
);

const sections = [
  {
    id: "who-we-are",
    title: "Who we are",
    body: (
      <>
        <p>
          {BRAND.name} (“{BRAND.name}”, “we”, “us”) makes the {BRAND.name}{" "}
          Shopify app, which cleans up product photos in bulk, and runs this
          website at{" "}
          <a href={BRAND.site}>{BRAND.site.replace("https://", "")}</a>.
        </p>
        <p>
          This policy covers both: <strong>merchants</strong> who install the
          app in their Shopify store, and <strong>visitors</strong> to the
          website, including people who try the photo demo or join the waitlist.
        </p>
        <p>
          For questions about privacy, or to use any of your rights, email{" "}
          <SupportEmail subject="Privacy" />.
        </p>
        <p>
          We decide how and why data about merchants and website visitors is
          used, so we are the controller of that data. Product photos in your
          store can show other people, such as models; we handle those images
          only on your behalf and only to provide the service to you.
        </p>
      </>
    ),
  },
  {
    id: "app-data",
    title: "Data from the Shopify app",
    body: (
      <>
        <p>
          When you install the app, Shopify gives us access to your store within
          the permissions you approve: reading and writing{" "}
          <strong>products</strong> and <strong>files</strong>. That&apos;s all
          we ask for. We hold:
        </p>
        <ul>
          <li>
            <strong>Store details:</strong> your store&apos;s Shopify address,
            when the app was installed or uninstalled, and the settings you save
            (canvas, margin, background colour, upscaling options).
          </li>
          <li>
            <strong>Access token:</strong> the key Shopify issues so the app can
            work with your products. We don&apos;t store the names or email
            addresses of you or your staff. Shopify&apos;s uninstall notice
            includes your store&apos;s contact details; we only use the store
            address from it and discard the rest.
          </li>
          <li>
            <strong>Product and image details</strong>, only for the products
            you select: product ID and title, image ID, position, alt text, the
            image&apos;s address on Shopify, file type, dimensions and file
            size.
          </li>
          <li>
            <strong>Images:</strong> a full-resolution backup of each original
            before it&apos;s changed, plus the cleaned image, previews and the
            cut-out mask we show you for review.
          </li>
          <li>
            <strong>Processing results:</strong> quality checks and flags, and
            which steps ran on each image.
          </li>
          <li>
            <strong>Credits and purchases:</strong> your credit balance and its
            history, and each credit pack you buy (pack, credits, price,
            currency, Shopify charge ID and status). Payment happens in Shopify;
            we never see card or bank details.
          </li>
        </ul>
        <p>
          We don&apos;t access customers, orders or any other protected customer
          data, and the app doesn&apos;t request permission to.
        </p>
      </>
    ),
  },
  {
    id: "website-data",
    title: "Data from this website",
    body: (
      <>
        <p>You can use the website without an account. We collect:</p>
        <ul>
          <li>
            <strong>Try-it photos:</strong> the photo you upload and the results
            we make from it. They aren&apos;t linked to your name or any
            account, and they&apos;re deleted after 24 hours.
          </li>
          <li>
            <strong>Your IP address, for rate limits:</strong> used as a counter
            so each visitor gets a few free tries a day and the forms can&apos;t
            be flooded. The counters expire after 48 hours.
          </li>
          <li>
            <strong>Waitlist email:</strong> if you join the waitlist for the
            web app and API, we store your email address and which option you
            picked, to send you one email when it launches.
          </li>
          <li>
            <strong>Emails to support:</strong> whatever you send us, so we can
            answer.
          </li>
          <li>
            <strong>Server logs:</strong> technical records of requests and
            errors, used to keep the site working and secure (see{" "}
            <a href="#retention">how long we keep them</a> below).
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and third-party requests",
    body: (
      <>
        <p>
          We don&apos;t use analytics, advertising or tracking cookies, pixels
          or similar tools.
        </p>
        <p>
          The website sets one functional cookie, and only in the site
          owner&apos;s own browser, to lift the daily try-it limit for testing.
          Visitors never get it. Inside Shopify, the app signs you in with
          Shopify&apos;s session tokens rather than cookies.
        </p>
        <p>
          Our web pages load their typefaces from Google Fonts, so your browser
          sends your IP address and browser details to Google when you open
          them. Google&apos;s use of that data is covered by the{" "}
          <a href="https://policies.google.com/privacy">
            Google privacy policy
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "how-we-use",
    title: "How we use data, and why we're allowed to",
    body: (
      <>
        <div className={s.tableWrap}>
          <table>
            <thead>
              <tr>
                <th scope="col">Purpose</th>
                <th scope="col">Data</th>
                <th scope="col">Legal basis (GDPR)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  Run the app: read, back up, clean, preview, apply and restore
                  your images
                </td>
                <td>
                  Store details, access token, product and image details, images
                </td>
                <td>Performing our contract with you</td>
              </tr>
              <tr>
                <td>Credits and purchases</td>
                <td>Credit and purchase records</td>
                <td>Performing our contract with you</td>
              </tr>
              <tr>
                <td>Try-it demo</td>
                <td>Your photo and its results, IP counter</td>
                <td>
                  Legitimate interests: showing you the service when you ask
                </td>
              </tr>
              <tr>
                <td>Launch email</td>
                <td>Waitlist email</td>
                <td>Your consent, which you can withdraw at any time</td>
              </tr>
              <tr>
                <td>Answering support requests</td>
                <td>Your emails and the store details needed to help</td>
                <td>
                  Performing our contract, or legitimate interests for
                  non-customers
                </td>
              </tr>
              <tr>
                <td>Showing our web pages (fonts)</td>
                <td>
                  Your IP address and browser details, sent to Google Fonts
                </td>
                <td>Legitimate interests: displaying the site consistently</td>
              </tr>
              <tr>
                <td>Security, abuse prevention, fixing problems and backups</td>
                <td>Server logs, IP counters, backup copies</td>
                <td>
                  Legitimate interests: keeping the service safe and working
                </td>
              </tr>
              <tr>
                <td>Meeting legal obligations</td>
                <td>Only what the law requires</td>
                <td>Legal obligation</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          We don&apos;t sell personal information or share it for advertising.
          We never use your images to train AI models: the models we use are
          already trained and only process your image to produce the result. We
          don&apos;t make automated decisions that have legal or similarly
          significant effects on you.
        </p>
      </>
    ),
  },
  {
    id: "providers",
    title: "Who we share data with",
    body: (
      <>
        <p>
          We use a few service providers to run {BRAND.name}. Each gets only
          what it needs to do its job:
        </p>
        <div className={s.tableWrap}>
          <table>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">What they do</th>
                <th scope="col">Data they receive</th>
                <th scope="col">Location</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>MVPS LTD</td>
                <td>
                  Hosts our server: the app, database, image storage, job queue
                  and image service all run there
                </td>
                <td>Everything the app and website store, on their hardware</td>
                <td>Netherlands (EU)</td>
              </tr>
              <tr>
                <td>Replicate, Inc.</td>
                <td>
                  Runs a larger AI model for photos whose cut-out from our own
                  server doesn&apos;t pass our quality checks, and AI upscaling
                </td>
                <td>
                  Image pixels only, as a JPEG with no file metadata: for
                  background removal, a copy no larger than 1,024 pixels on its
                  longest side; for AI upscaling (only when you turn it on, and
                  only for small photos), the photo at its original size. No
                  store name, product details or other identifiers. Replicate
                  deletes these inputs and outputs after one hour by default.
                </td>
                <td>United States</td>
              </tr>
              <tr>
                <td>Shopify</td>
                <td>
                  The platform the app runs on; installs, permissions and
                  billing for credit packs
                </td>
                <td>Data exchanged with your store as described above</td>
                <td>
                  See{" "}
                  <a href="https://www.shopify.com/legal/privacy">
                    Shopify&apos;s privacy policy
                  </a>
                </td>
              </tr>
              <tr>
                <td>Google</td>
                <td>
                  Google Fonts for our web pages; Gmail hosts our support
                  mailbox
                </td>
                <td>
                  Visitors&apos; IP address and browser details when fonts load;
                  emails you send to support
                </td>
                <td>United States and other countries</td>
              </tr>
              <tr>
                <td>Let&apos;s Encrypt</td>
                <td>
                  Issues the certificate that secures our HTTPS connection
                </td>
                <td>No personal data</td>
                <td>United States</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Background removal runs first on our own server in the Netherlands;
          a photo is sent to Replicate only when that result fails our
          automatic quality checks, or for AI upscaling. If Replicate is
          unavailable, everything stays on our server. Photos from the
          website&apos;s try-it demo go through the same image pipeline as
          merchants&apos; photos.
        </p>
        <p>
          We may also disclose data if the law requires it, or to protect our
          users or the service from fraud or abuse. If {BRAND.name} is ever sold
          or merged, the data would move to the new owner under this policy, and
          we&apos;d tell you first.
        </p>
      </>
    ),
  },
  {
    id: "transfers",
    title: "Where data is stored",
    body: (
      <>
        <p>
          Everything the app and website store is kept on a single server
          operated by MVPS LTD in the Netherlands, inside the European Union:
          the database, image storage (including your backups), the job queue
          and our image service. Emails you send to support are kept in our
          Gmail mailbox.
        </p>
        <p>
          Some providers are outside the EU. Replicate, in the United States,
          receives image pixels only, and we rely on Replicate&apos;s terms of
          service and data processing terms to protect that transfer. Google
          (fonts and our support mailbox) and Shopify protect international
          transfers under their own safeguards, described in their privacy
          policies.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "How long we keep data",
    body: (
      <>
        <div className={s.tableWrap}>
          <table>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">How long</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Access token</td>
                <td>
                  Until you uninstall; deleted as soon as Shopify tells us
                </td>
              </tr>
              <tr>
                <td>
                  Store details, settings, jobs, image details, credit and
                  purchase records
                </td>
                <td>
                  While the app is installed, then erased {ERASURE_WINDOW}
                </td>
              </tr>
              <tr>
                <td>Backups of your original images</td>
                <td>
                  While the app is installed, so you can restore at any time;
                  then erased {ERASURE_WINDOW}
                </td>
              </tr>
              <tr>
                <td>Cleaned images, previews and masks</td>
                <td>While the app is installed; erased with the rest</td>
              </tr>
              <tr>
                <td>Server backups</td>
                <td>
                  Nightly copies of the database and image storage, kept on our
                  server for 14 days. Copies of erased data are gone within 14
                  days after it&apos;s erased.
                </td>
              </tr>
              <tr>
                <td>Server logs</td>
                <td>
                  Rotated automatically: each service keeps at most three 10 MB
                  files and overwrites the oldest. There&apos;s no long-term log
                  archive.
                </td>
              </tr>
              <tr>
                <td>Job queue entries (IDs only, no images)</td>
                <td>Up to 7 days</td>
              </tr>
              <tr>
                <td>Try-it photos and results</td>
                <td>24 hours</td>
              </tr>
              <tr>
                <td>IP counters for rate limits</td>
                <td>48 hours</td>
              </tr>
              <tr>
                <td>Waitlist email</td>
                <td>
                  Until we send the launch email, and never more than 12 months.
                  Deleted sooner if you ask.
                </td>
              </tr>
              <tr>
                <td>Support emails</td>
                <td>
                  As long as needed to help you and handle follow-ups; deleted
                  on request
                </td>
              </tr>
              <tr>
                <td>Images sent to Replicate</td>
                <td>Deleted by Replicate after one hour by default</td>
              </tr>
            </tbody>
          </table>
        </div>
      </>
    ),
  },
  {
    id: "uninstall",
    title: "What happens when you uninstall",
    body: (
      <>
        <ol>
          <li>
            <strong>Right away:</strong> we delete the access token and stop any
            jobs in progress. Nothing in your store is changed.
          </li>
          <li>
            <strong>48 hours later:</strong> Shopify asks us to erase your
            store&apos;s data, and we delete everything we hold for it: store
            details, settings, jobs, credit balance and purchase records,
            backups, cleaned images and previews.
          </li>
          <li>
            <strong>At the latest 25 days after uninstalling:</strong> if that
            request never arrives, we erase the data anyway. Either way
            it&apos;s gone {ERASURE_WINDOW}.
          </li>
          <li>
            <strong>Within 14 more days:</strong> the last server backup copies
            that contained it expire.
          </li>
        </ol>
        <p>
          If we missed Shopify&apos;s uninstall notice, the erase request makes
          us check with Shopify whether the app is still installed, and we erase
          the data if it isn&apos;t. We also run that check on stores that
          haven&apos;t used the app for a few days, so the data is still erased
          within 30 days if both of Shopify&apos;s notices are lost. If you
          reinstall before the data is erased, it&apos;s kept and your restores
          keep working.
        </p>
        <p>
          <strong>
            After erasure we can&apos;t restore your originals, and unused
            credits are gone too.
          </strong>{" "}
          Restore anything you want to keep before you uninstall.
        </p>
        <h3>Shopify&apos;s privacy requests</h3>
        <p>
          Shopify sends apps three kinds of privacy requests. For{" "}
          <strong>customer data requests</strong> and{" "}
          <strong>customer erasure requests</strong>, there&apos;s nothing to
          return or delete, because we don&apos;t store any data about your
          customers. For <strong>store erasure requests</strong>, we erase your
          store&apos;s data as described above.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "How we protect data",
    body: (
      <>
        <ul>
          <li>
            All traffic to the app and website is encrypted with HTTPS (TLS).
          </li>
          <li>
            The app asks Shopify only for the permissions it needs: products and
            files.
          </li>
          <li>
            Messages from Shopify are checked against their HMAC signature
            before we act on them.
          </li>
          <li>
            The database, image storage, job queue and image service are on an
            internal network and can&apos;t be reached from the internet. Only
            the web app is public.
          </li>
          <li>
            Requests between our app and our image service are signed. Stored
            images can only be opened through signed links that expire after at
            most two hours.
          </li>
          <li>
            Originals are backed up before any change, and the server keeps
            nightly backups.
          </li>
          <li>Access to the server is limited to the operator.</li>
        </ul>
        <p>
          No system is perfectly secure. If a breach affects your data,
          we&apos;ll tell you and the relevant authorities as the law requires.
        </p>
      </>
    ),
  },
  {
    id: "rights",
    title: "Your rights",
    body: (
      <>
        <p>
          Depending on where you live (for example under the EU or UK GDPR, or
          California&apos;s privacy laws), you have the right to:
        </p>
        <ul>
          <li>
            know what personal data we hold about you and get a copy of it;
          </li>
          <li>have it corrected if it&apos;s wrong;</li>
          <li>have it deleted;</li>
          <li>restrict or object to how we use it;</li>
          <li>receive it in a portable format;</li>
          <li>
            withdraw your consent at any time (for the waitlist), without
            affecting what we did before;
          </li>
          <li>not be treated differently for using these rights.</li>
        </ul>
        <p>
          To use any of them, email <SupportEmail subject="Privacy request" />.
          Merchants: tell us your store&apos;s address, and we may ask you to
          confirm the request from your Shopify admin or store email. We answer
          within one month. You can also delete all your store&apos;s data
          yourself by uninstalling the app.
        </p>
        <p>
          If you&apos;re unhappy with how we handle your data, please tell us
          first. You also have the right to complain to a data protection
          authority, such as the one in the EU country where you live, the Dutch{" "}
          <a href="https://www.autoriteitpersoonsgegevens.nl/en">
            Autoriteit Persoonsgegevens
          </a>
          , or the UK&apos;s{" "}
          <a href="https://ico.org.uk/make-a-complaint/">
            Information Commissioner&apos;s Office
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        {BRAND.name} is a tool for businesses and isn&apos;t meant for children
        under 16. We don&apos;t knowingly collect their personal data; if you
        think a child has given us some, email us and we&apos;ll delete it.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        When we change this policy, we update it here and change the date at the
        top. If a change affects how we use data we already hold, we&apos;ll say
        so on this page before it takes effect and, where we can, tell merchants
        by email or in the app.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        {BRAND.name}: <SupportEmail subject="Privacy" />. See also our{" "}
        <a href={PAGES.terms}>terms of service</a> and{" "}
        <a href={PAGES.support}>support page</a>.
      </p>
    ),
  },
];

export default function Privacy() {
  return (
    <LegalLayout
      path={PAGES.privacy}
      kicker="Privacy"
      title={
        <>
          Privacy <em>policy</em>
        </>
      }
      lede={`What ${BRAND.name} collects when you use the Shopify app or this website, why, where it's kept, for how long, and how to have it deleted.`}
      updated={LEGAL_UPDATED}
      summary={summary}
      sections={sections}
    />
  );
}
