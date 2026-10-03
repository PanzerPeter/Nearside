# Nearside on an iPhone, without the App Store

You install it yourself with your own free Apple ID. It takes about ten minutes
the first time. You need the iPhone, its cable, and a Windows PC or a Mac.

**Before you start, know this:** a free Apple ID signs apps for **7 days**.
After that the app stops opening until you redo step 4 (about one minute). Your
messages and account are still there. **Never delete the app** to fix it,
because that can take your account with it. Write down the twelve recovery
words when the app shows them.

## 1. Get the file

Download **Nearside.ipa** from
<https://github.com/PanzerPeter/Nearside/releases/download/ios-latest/Nearside.ipa>

## 2. Install Sideloadly

From <https://sideloadly.io>.

- **Windows:** you also need iTunes and iCloud **from apple.com**, not the
  Microsoft Store versions. Sideloadly links to them.
- **Mac:** nothing else.

## 3. Connect the iPhone

Plug it in with the cable, unlock it, and tap **Trust** when it asks.

## 4. Install the app

1. Open Sideloadly. Your iPhone should show up at the top.
2. Drag `Nearside.ipa` onto the window.
3. Type your Apple ID email and click **Start**.
4. Enter your Apple ID password, then the 6-digit code that pops up on your
   phone.

If it complains about the bundle ID, open **Advanced Options**, set
**Bundle ID** to something unique like `app.nearside.yourname`, and try again.
Use the same one every week.

## 5. Allow it on the iPhone (first time only)

1. **Settings → General → VPN & Device Management**, tap your Apple ID, then
   **Trust**.
2. **Settings → Privacy & Security → Developer Mode**, turn it on. The phone
   restarts. Confirm with **Turn On** afterwards.

Open Nearside.

## What doesn't work in this build

- **No notifications.** A free Apple ID can't receive push. Messages show up
  when you open the app.
- **Calls only ring while the app is open.**
- **Theme store packs are unavailable.** The free themes work.

## Optional: no computer after setup

[SideStore](https://sidestore.io) can renew the 7 days from the phone itself.
Setting it up needs a computer once, and it takes more steps than Sideloadly.
After that you open SideStore once a week and tap **Refresh**.
