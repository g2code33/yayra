# Google OAuth verification packet for Yayra

This packet prepares the public materials and technical evidence for the Google
OAuth review. It does not mean Google has approved the app. Only the Google
Cloud project owner can submit the project, respond to reviewer questions, and
complete any required restricted-scope security assessment.

## Public app details

Use these URLs only after the Pages site has been deployed and each page has
been checked in a signed-out browser over HTTPS:

| Google Auth Platform field | Value |
| --- | --- |
| App name | `yayra browser` |
| Application home page | `https://yayra.app/about/` |
| Privacy policy | `https://yayra.app/privacy/` |
| Terms of Service | `https://yayra.app/terms/` |
| Authorized domain | `yayra.app` |
| User support / developer contact | `support@yayra.app` |

The domain must be controlled by the project owner and verified in Google
Search Console. Use the same verified domain for the public policy pages and
Google OAuth web origin. Do not enter these URLs in the console until live.

## Suggested product description

> Yayra is an independent cross-platform browser. Users can optionally connect
their Google account to display their account identity and, after separate
consent, use read-only Google service previews inside the browser. Yayra uses
only the data required for the feature the user selects. It does not sell Google
user data, use it for advertising, or send Google API data to generative AI
providers. Users can disconnect the integration in Yayra or revoke access in
their Google Account settings.

Use this description only if it remains accurate for the submitted release.

## Scope inventory and purpose

Yayra implements basic account identity and several separately consented
read-only capabilities. The Google consent screen must list every scope used by
the OAuth client being reviewed; remove any scope that the submitted build does
not actually need. Do not claim that scopes are never requested together: the
Google services hub currently requests its enumerated read-only set together,
while the Gmail and Drive entry flows can request their narrower scopes.

| Scope | User-facing purpose | Data displayed/processed |
| --- | --- | --- |
| `openid`, `email`, `profile` | Identify the Google account the user selected and show its identity in Yayra. | Stable account identifier, email, name, profile image. |
| `https://www.googleapis.com/auth/gmail.readonly` | User-requested Gmail inbox/search/message preview. | Bounded message metadata, snippets, and plain-text message content. No send, delete, or modify operations. |
| `https://www.googleapis.com/auth/drive.readonly` | User-requested Drive listing/preview and recovery of a selected Drive download. | File metadata and, only when requested, the selected file's bytes. |
| `https://www.googleapis.com/auth/calendar.readonly` | Calendar preview and event listing. | Primary calendar event details needed for the preview. |
| `https://www.googleapis.com/auth/contacts.readonly` | Contacts preview. | Limited contact names, email addresses, and profile photos returned by the API. |
| `https://www.googleapis.com/auth/photoslibrary.readonly` | Photos preview. | Media items/metadata returned by the approved API. Confirm the exact scope remains supported for this project before submission. |
| `https://www.googleapis.com/auth/tasks.readonly` | Tasks preview. | Default task-list entries needed for the preview. |
| `https://www.googleapis.com/auth/classroom.courses.readonly` | Classroom course preview. | Course information returned by the API. |
| `https://www.googleapis.com/auth/youtube.readonly` | YouTube channel preview. | The user's channel metadata returned by the API. |

All API scopes above are intended for read-only use. The app does not request
Gmail send/write, Drive write, or broad `cloud-platform` access. Scope
classifications and review requirements are determined by Google and may
change. Gmail and some other scopes may require sensitive/restricted-scope
verification; a restricted-scope security assessment may also be required.

## Data handling shown in the policy

- Basic identity access is used to return a bounded account profile; the
  authentication service discards the Google tokens after this basic flow.
- For optional Google API features, desktop credentials are kept in
  OS-protected app storage where available. Supported web/mobile delegated
  credentials are encrypted server-side with a configured maximum lifetime of
  30 days; disconnect requests revoke and delete the delegated session.
- Web/mobile renderer code receives an opaque session capability, not a raw
  Google access or refresh token.
- Google API responses are used for the user-selected preview/download feature.
  Google API data is not sold or used for targeted advertising. The app does
  not automatically send Google API responses to AI; if a user manually copies
  Google data into an AI prompt, that user-entered prompt is sent to the AI
  provider and is subject to the separate AI disclosure.
- AI prompts are a separate optional feature. A prompt and text deliberately
  included by the user are sent to Yayra's configured AI service and NVIDIA;
  the privacy policy asks users not to include confidential data.
- Browsing history, bookmarks, passwords, downloads, and local documents are
  stored in the local browser profile and are not uploaded by Google sign-in.

These statements must be rechecked against the actual production configuration
and release. If a data flow changes, update the policy and resubmit before
continuing to make the corresponding claim.

## Required Google Cloud setup

1. Confirm the OAuth consent-screen user type is **External** if users outside
   the project owner's Workspace organization need access.
2. Add the public product details above under **Google Auth Platform →
   Branding**. Link the privacy policy and terms from the about page and ensure
   all pages load without signing in.
3. Verify `yayra.app` in Search Console and list it under **Authorized domains**.
4. Under **Data access**, request only scopes present in the submitted app. Give
   a concise feature-by-feature justification for each sensitive/restricted
   scope.
5. For the Web OAuth client, register the exact production values:
   - Authorized JavaScript origin: `https://yayra.app`
   - Authorized redirect URI: `https://yayra.app/auth/callback`
6. Set the Worker's exact `GOOGLE_WEB_ALLOWED_ORIGINS` to include
   `https://yayra.app`; deploy the Worker and Pages changes. Never use `*`.
7. Publish the app and submit the required branding/scope verification in
   **Verification centre**. Respond to reviewer questions. Complete Google's
   required security assessment if the scope classification requires it.
8. Test the production configuration with a clean Google account: basic sign-in,
   each scope-dependent feature, denial/cancellation, disconnect, revocation,
   and data deletion. Confirm the production OAuth client ID, API enablement,
   Worker secrets, KV binding, and allowed origin match the submitted project.

## Reviewer demonstration video

Prepare an unedited, accessible screen recording (for example, an unlisted
video URL if that is what the verification form accepts) that shows:

1. The app name and the app's public home page.
2. The user deliberately opening the Google feature being reviewed.
3. The complete Google consent screen, including requested scopes.
4. The granted data appearing only in the corresponding Yayra feature.
5. That the feature is read-only and does not repurpose Google data for ads or
   AI.
6. How to disconnect Yayra and revoke access.

Use a dedicated Google test account containing only synthetic/demo data. Do not
show real mail, contacts, files, passwords, tokens, OAuth authorization codes,
or other users' personal information. Make the video available to Google's
reviewers for the duration of review.

## Before submitting

- [ ] Pages deployed and open without login: `/about/`, `/privacy/`, `/terms/`.
- [ ] Confirm the publisher's legal operating name and any disclosure/address
      required by its jurisdiction; verify `support@yayra.app` is monitored.
- [ ] `yayra.app` ownership is verified in Search Console.
- [ ] All authorized origins and redirect URIs exactly match the production app.
- [ ] Every requested scope has a working, visible feature and a truthful
      justification; unused scopes are removed.
- [ ] Google APIs are enabled for only the shipped features.
- [ ] Privacy policy accurately matches Cloudflare, Google, and NVIDIA data
      flows and current retention/configuration.
- [ ] OAuth verification form and reviewer video are complete.
- [ ] Restricted-scope assessment is complete if Google requires it.

Google alone decides whether verification is granted. A complete website and
submission improve readiness but cannot guarantee approval or a review date.
