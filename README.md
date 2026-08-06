# Nearside

A fast, real-time direct-messaging PWA. Add friends by username and chat one-to-one
with text, images, and video — installable on mobile and desktop.

Built with React + TypeScript + Vite, TailwindCSS + daisyUI, and Supabase
(Auth, Postgres, Realtime, Storage).

## Features

- Email/password auth with username, editable later, and email password reset
- Friend requests by username (search, accept, decline)
- Private friend nicknames: name someone whatever you like, visible only to you
  (they are never told), used in the sidebar, the chat header and notifications
- A note-to-self chat, pinned to the top of the list for every account — the
  full chat with media, voice notes, replies and reactions, minus the things
  that need a second person (presence, typing, ticks, notifications)
- Real-time 1:1 messaging with typing indicators
- Message edit and delete (soft delete)
- Image and video sharing (newest 20 media kept per conversation), with images
  re-encoded to WebP on the device before upload
- Voice messages up to 2 minutes: hold the mic on a phone, click it on a
  desktop (newest 50 kept per conversation)
- Camera capture from the attachment sheet on phones — photo or video, straight
  into the conversation
- Per-conversation chat background image, set independently by each user
- Avatar upload
- Message pagination (load older on demand)
- Installable PWA with offline app shell
- Survives sleep, network loss and blocked WebSockets: the app detects wake
  (including on desktop, where nothing fires an event), rebuilds its realtime
  subscriptions, backfills whatever it missed, and falls back to polling while
  live delivery is down — with a banner saying so

## Connectivity notes

Realtime runs over a WebSocket. Some networks — corporate proxies, and a number
of routes reached through a VPN — stall or drop `wss://` while ordinary HTTPS
keeps working. When that happens the app keeps functioning on its polling
fallback (a few seconds' latency instead of instant), rather than appearing to
work while silently showing a frozen conversation.

If a whole region can't reach `*.supabase.co` at all, the fix is a custom
domain in front of the Supabase project (Supabase → Settings → Custom Domains)
plus `VITE_SUPABASE_URL` repointed at it. Domain-level blocks don't follow the
CNAME.

## Prerequisites

- Node.js 20.19+ (Vite 8 requirement)
- A Supabase project

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a Supabase project, then in the SQL editor run, in order:

   - every file in `supabase/migrations/` in ascending numeric order
     (`0001_init.sql` … `0013_chat_backgrounds_per_user.sql`) — tables,
     RLS, triggers, realtime
   - `0014_server_side_push.sql` is optional and needs configuration before it
     does anything; see `supabase/SETUP.md`
   - `0015_voice_messages.sql` — the `audio` media kind and recorded length
   - `0016_friend_nicknames.sql` — private per-user nicknames
   - `0017_self_chat.sql` — the note-to-self conversation. Widens the message
     INSERT policy to allow addressing yourself, stops your own notes counting
     as unread, and adds your own row to `conversation_list()`
   - `supabase/storage-setup.sql` — `avatars` and `chat-media` buckets + policies

3. In Supabase **Authentication → URL Configuration**, add your site URL and
   `/*` redirect so password-reset links return to the app.

4. Copy `.env.example` to `.env` and fill in your project values:

   ```bash
   cp .env.example .env
   ```

   ```
   VITE_SUPABASE_URL=https://<your-project>.supabase.co
   VITE_SUPABASE_ANON_KEY=<your-anon-or-publishable-key>
   ```

5. Run locally:

   ```bash
   npm run dev
   ```

## Scripts

| Command             | Purpose                     |
| ------------------- | --------------------------- |
| `npm run dev`       | Start the dev server        |
| `npm run build`     | Production build to `dist/` |
| `npm run preview`   | Preview the production build|
| `npm run typecheck` | TypeScript check, no emit   |
| `npm run lint`      | ESLint                      |

## Deploy (Netlify)

`netlify.toml` is included (build `npm run build`, publish `dist`, SPA redirect).
Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in
**Site settings → Environment variables**, then deploy.
