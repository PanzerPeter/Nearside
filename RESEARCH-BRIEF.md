# Shipaton 2026 — Idea Research & Brainstorm Brief
_Compiled 2026-08-05. All competitor facts sourced; links at bottom._
_Revised 2026-08-05 after reading [STREAM-ASR.md](STREAM-ASR.md) — see §1b for what changed._

---

## 0. Rules re-check (things that change the plan)

Confirmed from the [Devpost rules page](https://revenuecat-shipaton-2026.devpost.com/rules) and [RevenueCat's prep codelab](https://revenuecat.github.io/codelabs/shipaton-2026-prep.html):

| Item | Finding | Impact |
|---|---|---|
| Submission window | Jul 31 2026 08:00 PDT – Sep 30 2026 23:45 PDT | As briefed |
| Stores | Apple **or** Google Play **or** Samsung Galaxy | Play alone is fine for Grand Prize / Catvertising / OneSignal / Design |
| RC requirement | "RevenueCat SDK to power at least one in-app or web purchase, **or** that serves ads through RevenueCat Ads" | Ads path is explicitly valid for *all* categories, not just Catvertising |
| Promo code / trial | Rules text reads as a universal requirement ("the app must either offer a free trial or the Entrant must include a promo code"). I found **no** ads-only exemption | See open question Q5 — but the recommended design sidesteps it entirely (below) |
| **Play closed testing** | New Google Play personal dev accounts require **12+ testers for 14 consecutive days** before production access | **Biggest schedule risk in the whole project.** Codelab's own backward plan: closed testing running by **Sep 1**, store submission by **Sep 16**, live by **Sep 23** |
| Grand Prize revenue | Codelab says judged "largely on real user traction and growth" — no revenue-reporting mechanics documented | Open question Q6 |

### RevenueCat Ads is NOT an ad network — important correction

Per [RevenueCat's ad-monetization docs](https://www.revenuecat.com/docs/ad-monetization): it is an **event-tracking layer**, currently **beta**, that sits on top of your existing ad SDK. Flow is `Your App → Ad SDK callback → RevenueCat AdTracker → RC backend → Charts`. Direct helper integration exists for **Google AdMob** (`loadAndTrack` wrappers); manual integration for AppLovin MAX, ironSource, Unity Ads.

Consequences:
- You still need an **AdMob account and AdMob mediation**. RevenueCat does not fill ads.
- Ad revenue is free to track because it **does not contribute to RC billing** — which strongly implies it is not counted as "revenue" the way subscription MRR is. Do not assume ad dollars get you onto a revenue leaderboard.
- Supported: Banner, Interstitial, Rewarded, Rewarded Interstitial, App Open, Native. Android SDK 8.0.0+.

### Award categories — full list (more than briefed)

Core: Grand Prize · #BuildInPublic · Best Game · Peace Prize · Design Award · Next Gen (students) · Conflict of Interest.
Sponsored: **Catvertising** ($15k first place) · HAMM · **Keep Them Coming Back (OneSignal, $45k pool)** · Ship Kotlin Everywhere (JetBrains) · Most Viral App (Noise) · Best App for Galaxy (Samsung, 20% weighting on Galaxy optimization) · Idea to Income (Replit) · The Growth Loop (Layers) · Funnel Vision (Stripe).
Five influencer awards — **Christopher Lawley / Productivity is Apple-ecosystem-oriented**; that is the one category where shipping iOS actually matters. Everything else you're targeting is Play-satisfiable.

OneSignal eligibility (from [onesignal.com/shipaton](https://onesignal.com/shipaton)): publish a live app, integrate OneSignal, deploy ≥1 campaign, and **write a description of how OneSignal was used**. Perk: 100% off Growth plan up to 3 months.

---

## 1. The technical fact that decides everything

**Whisper cannot stream. Your architecture can.**

Every offline-transcription app currently on Play is Whisper-based (Whisper's 30-second encoder window is architecturally non-streaming). Documented consequences:

- whisper.cpp on Android in live-streaming mode: **~5–7 seconds of compute per 1 second of new audio**, with latency that *grows unboundedly* (3s → 10s → 30s) until ANR or process kill ([ggml-org/whisper.cpp discussion #3567](https://github.com/ggml-org/whisper.cpp/discussions/3567)).
- Chunked workarounds trade accuracy for delay and induce hallucinations on short inputs (Whisper is unstable outside its 30s training distribution).

Meanwhile streaming Zipformer-transducer — **your exact architecture** — is a solved on-device deployment:

- sherpa-onnx reports **RTF 0.05** for streaming Zipformer-EN on iPhone 15 Pro and **RTF 0.03** on a Pixel 6 with NNAPI ([sherpa-onnx docs](https://k2-fsa.github.io/sherpa/onnx/index.html)).
- icefall ships `egs/librispeech/ASR/zipformer/export-onnx-streaming.py` — a first-party export path straight into sherpa-onnx's Android runtime.

**So the honest framing of your moat is not "on-device ASR." It is "on-device ASR that produces words *while the person is still speaking*."** Batch transcription on-device is a solved, commoditized, already-shipped category. Live low-latency captioning on-device is not. Every idea below is ranked by how much it depends on that distinction.

---

## 1b. Revision after reading STREAM-ASR.md

The streaming question is **answered and the answer is good**. Four other things got worse, and one got better.

### ✅ Streaming is real and by construction
`ZipformerEncoder.streaming_forward()` is exactly equivalent to full-context `forward()` on every aligned frame, with a test locking the equivalence. Causal `Conv2dSubsampling`, per-frame `BiasNorm` instead of chunk-normalisation, RoPE with `pos_offset`. Dynamic-chunk masking gives **one weight set for both modes** — no second model to train, no second export. Algorithmic latency is the 320 ms chunk, matching icefall's streaming reference. The moat thesis in §1 holds.

Corrected headline numbers (the brief above used 3.55%; the actual figures are):

| | offline | streaming |
|---|---|---|
| test-clean, `beam_lm` | 3.43 % | **4.45 %** |
| test-clean, `beam` (no LM) | 4.38 % | **5.84 %** |
| test-clean, `greedy` | 4.55 % | **6.15 %** |
| test-other, `beam_lm` | 9.17 % | **12.24 %** |
| test-other, `beam` (no LM) | 10.90 % | **14.35 %** |
| test-other, `greedy` | 11.44 % | **15.29 %** |

### ⚠️ Risk 1 — the RTF numbers are GPU numbers
RTF 0.074 streaming is measured on an RTX 5070. That says nothing about a mid-range Android SoC. The encouraging comparison is that sherpa-onnx's streaming Zipformer is *larger* (70.4 M vs your 53.8 M encoder) and hits RTF 0.03 on a Pixel 6 with NNAPI — so the architecture class is proven on phones. But **your** int8 ONNX export on **your** target device is an unmeasured number until you measure it. This is the single benchmark that has to exist before product code.

### ⚠️ Risk 2 — the LM almost certainly does not ship to the phone
STREAM-LM is a causal Transformer doing n-best rescoring plus an ILME subtraction pass. Running that per utterance on-device, live, is a much bigger ask than the transducer itself. Assume the shipped device config is **`beam` or `greedy`, acoustic-only**. That moves your real-world starting point from 4.45 % to **5.84–6.15 % on clean speech, and 14.35–15.29 % on test-other**. Plan the product around the acoustic-only numbers and treat the LM as a stretch goal, not a baseline.

### ⚠️ Risk 3 — test-other is the honest predictor, and it's the weak column
Your own README says it: the streaming-to-offline gap widens from 1.02 abs points on clean to 3.07 on other — "the chunked causal encoder costs three times as much when the acoustics are hard" — and remaining work is "robustness on noisy and accented speech rather than clean read speech." A Deaf/HoH group conversation in a restaurant is *worse* than test-other: far-field, overlapping speakers, reverberation, accents, and none of it read speech.

**But the multi-device room architecture is itself the mitigation, and this is the strongest argument for idea A.** Each participant's phone captions **its own owner's voice from its own microphone at close range** — near-field, single-speaker, high SNR, one speaker per stream. That is far closer to LibriSpeech conditions than one phone on a table trying to hear four people. The design that gives you free diarization also gives you the acoustic conditions your model is actually good at. Single-device far-field mode should ship, but marketed honestly as the fallback, not the hero.

### ⚠️ Risk 4 — no punctuation, no casing
LibriSpeech transcripts are upper-case and unpunctuated, so the model cannot emit either; the demo's sentence-casing is a display-path heuristic that explicitly "infers nothing else." For a *captioning* product this is a real UX regression versus Live Transcribe, which punctuates. A wall of unpunctuated text is materially harder to read, and your users are people for whom reading the text *is* the conversation.

**Fix, and it's cheap:** sherpa-onnx ships [`sherpa-onnx-online-punct-en-2024-08-06`](https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html) — an English **online** punctuation + truecasing model, already int8, from [Edge-Punct-Casing](https://github.com/frankyoujian/Edge-Punct-Casing). Streaming-compatible, so it fits live captions rather than only final text. Caveat to verify: [issue #2568](https://github.com/k2-fsa/sherpa-onnx/issues/2568) reports the `OnlinePunctuation` Java APIs were missing from the Android AAR, with a fix landed — confirm the API is exposed in the AAR version you pull.

### ⚠️ Risk 5 — no icefall means the export is yours to write
Pure PyTorch, no k2, no icefall, safetensors checkpoints. So `export-onnx-streaming.py` will not run against your code. The good news is that your architecture is *shaped* like icefall's: a `StatelessPredictor` whose entire streaming state is the last `context-1` token ids (no recurrence to serialize), and an additive project-sum-tanh-readout joiner. Those are the two pieces that usually make a transducer awkward to export, and both are already in the easy configuration. The friction is the **encoder state layout** — sherpa-onnx expects icefall's specific list of cached tensors (`cached_len`, `cached_avg`, `cached_key`, `cached_val`, `cached_conv`), and yours will not match without deliberate work.

### 🔀 Note on the retrain in progress
`config/training.yaml` now targets 600k batches / 45,700 h, restarted from scratch today after two gradient-runaway aborts. It will improve every number above. **Do not put it on the app's critical path** — it wants the same GPU you'd want for export experiments, and a hackathon schedule cannot absorb a third abort. Ship against `transducer_avg.pt` as it exists today; swap in the better checkpoint as a post-launch "accuracy update," which is itself a nice #BuildInPublic and Grand-Prize-growth beat.

### 📜 Licensing
Apache-2.0 with a binding §4(d) NOTICE requirement. Ship an open-source-licenses screen carrying the STREAM ASR attribution alongside sherpa-onnx, ONNX Runtime and the punctuation model. Ten minutes of work; do it in week 1 rather than remembering it at submission.

---

## 2. Candidate problem spaces

### A. Shared live-caption rooms for Deaf / hard-of-hearing group conversation ⭐

**User & problem.** A Deaf or HoH person in a multi-person, in-person conversation — a family dinner, a standup, a class, a doctor's appointment. One-to-one captioning is roughly solved; *group* is not. Built-in captions in Meet-type products are ephemeral and not speaker-attributed, which is precisely what makes them useless for following a room.

**Incumbents & their specific weaknesses.**

| App | Model | Weakness |
|---|---|---|
| **Ava** | $9.99/mo annual, $14.99/mo monthly → **3 hours** of premium captions, sessions capped at 40 min, extra hours **$4.99/hr** | Metered because cloud STT costs per minute. Users report save-transcript failures and unhelpful support; works on strong WiFi but degrades on cellular; speaker attribution not available on lower tiers. Costs escalate fast for a student attending multiple lectures. |
| **Google Live Transcribe** | Free | **Transcripts auto-delete after 3 days** (24h if history off), **no export** — users must manually copy-paste; no separate conversation files; single-device only, no shared room. |
| **InnoCaption** | Free (FCC-funded) | US **phone calls only**; requires hearing-loss certification. Not in-person. |
| **Rogervoice / Rylo** | Subscription / call-focused | Call captioning, cloud, not in-person group. |
| **AR caption glasses** (XRAI, AirCaps, Even Realities) | $300–800 hardware | Hardware cost; not a software-market answer. |

**Why on-device specifically matters here (not fake).** Cloud STT is billed per minute — that *is* the reason Ava meters you at 3 hours. Kill the per-minute cost and you can credibly offer **unlimited captioning for free**, which is a positioning no cloud-backed competitor can match without burning money. Add: works in a basement clinic / plane / abroad with no roaming; and privacy matters enormously for the actual use cases (medical appointments, therapy, legal, HR meetings). Latency also matters — a caption arriving 3 seconds late is unusable for turn-taking.

**Why your chat app is a genuine accelerant, not a reskin.** The shared-room design is: *each participant's own phone runs local ASR on their own voice and publishes text into a Supabase realtime room.* That gives you **perfect speaker diarization for free** — the hardest problem in this space — because every device knows who owns it. Ava spends cloud money and ML effort on diarization; you get it from device identity. Auth, realtime, storage, presence, and invite flows already exist in your codebase. This is the only idea on the list where **both** assets are load-bearing.

**Catvertising concept.** Hard rule: **zero ads in the live caption view, ever.** That's the story you tell judges — "we monetize the archive, never the conversation." Then:
- *Rewarded video* to save a session permanently beyond a rolling free window (e.g. last 3 sessions kept), or to unlock PDF/DOCX export of a transcript — solving Live Transcribe's #1 documented complaint, funded by an ad the user opts into at the exact moment they feel the value.
- *Native ad card* in the transcript-library list, styled as a list item.
- *App Open* ad on cold start **only when no session is in progress**.
- Pair with a cheap "Supporter" IAP that removes ads + unlimited saves → hybrid model → also **HAMM-eligible**, and the IAP trivially satisfies the free-trial/promo-code submission rule.

**OneSignal concept (beyond a generic push).**
1. **Transactional room invite**: "Sarah started a caption room — tap to join." Genuinely functional push; the product doesn't work without it.
2. **Post-session deep-link**: "Transcript ready — 14 min, 3 speakers" → opens straight to the transcript.
3. **In-App Message** (not push) fired at the moment a user hits the save limit, offering the rewarded-ad unlock. This wires OneSignal *into the monetization moment* — which is exactly the "resourcefulness / advanced use beyond a push blast" the OneSignal criteria ask for, and it double-scores with Catvertising.

**Feasibility, solo, 8 weeks.** Medium-high. Riskiest piece is ASR export (§6). Everything else is CRUD + realtime you already have. Live caption UI is where the Design Award points get earned (word-level fade-in, per-speaker color, scroll pinning, haptics on speaker change).

**Store.** Play alone. Peace-Prize-eligible on genuine merit.

---

### B. Private on-device meeting / lecture recorder ("no bot joins your call")

**User & problem.** Anyone who wants meeting notes but cannot or will not let a cloud notetaker into the room — regulated employers, HR conversations, legal, therapists, journalists with sources.

**Incumbents & weaknesses.** **Otter.ai**: free tier is 300 min/month, 30 min per conversation, and *three lifetime* file imports; Pro $8.33/mo annual ($16.99 monthly). More importantly Otter is defending a **federal class action in California** alleging its Notetaker secretly recorded conversations without participant consent and used them to train models — the complaint notes non-host participants cannot disable it. **Fireflies / tldv / Fathom** share the "a bot joins your meeting" pattern. This is a live, dated, nameable wedge.

**Why on-device matters.** Strong on privacy and cost; **weak on latency** — nobody needs sub-second meeting transcription. So only *half* your moat applies. And the real user value is in the *summary*, which needs an LLM → per-user cloud cost → poor fit with ad-supported economics.

**Chat app leverage.** Moderate (storage, auth, sharing). The realtime layer is mostly idle.

**Ads / OneSignal.** Rewarded ad for summary credits; OneSignal push when a long transcription finishes. Both fine, neither special.

**Feasibility.** High. **Structural problem:** meetings happen on laptops, so a phone-only capture product is awkward, and B2B-ish privacy buyers don't produce the viral install curve the Grand Prize rewards.

---

### C. Android offline dictation / notes for people who can't type comfortably

**Incumbents.** **FUTO Voice Input** — free/pay-what-you-want, Whisper-based, fully offline, well-reviewed, actively developed. **Sayboard** (Vosk, free, weak accuracy). **Private Dictation: Offline AI** and **Speech to Text – ASR Offline** on Play, both Whisper-based. Gboard voice is cloud-by-default.

**Weaknesses.** FUTO's known issues are model-download failures ("everyone literally is complaining"), noticeably slow on older devices, and weaker non-English quality. All Whisper-based rivals are batch: press, speak, wait, then text appears.

**Why on-device matters.** It's the whole category — but that means **it's table stakes, not a differentiator**. Your edge would be purely "live text as you speak vs. wait-then-dump," which is real but narrow.

**Verdict.** Fighting a competent, free, ideologically-motivated incumbent on its home turf. Better absorbed as a *feature* of A (a dictation surface inside the captioning app) than shipped as a product.

---

### D. Field / trades / no-signal voice notes

**Incumbents.** Speakwise, VoiceScriber, Whisper Notes, Voice Note Pro, VoiceField. Genuinely notable: **this category is iOS-heavy and Android is thin** — one 2026 roundup states plainly that "on Android, options are still thin."

**Verdict.** Real gap, real willingness to pay — but B2B-flavored, slow-growth, and professional users are the worst possible audience for ads. Bad Grand Prize fit in an 8-week growth window. Mid-low.

---

### E. Voice journaling

**Incumbents.** AudioPen (free ≈10 notes / 3-min cap, English-only; paid is a one-time pass at **$99/yr, $159/2yr, ~$33/3mo**; web + Chrome only). Voicenotes (free 3-min sessions; **Prime $75/yr**). Day One. Already-shipped on-device rivals: **Private Dictation: Offline AI**, **CortexOS**.

**Why on-device is partly fake here.** Journaling is asynchronous — cloud batch STT works fine, and on-device *batch* competitors already exist on Play. Your streaming edge buys you nothing. Privacy is a genuine but crowded pitch.

**Verdict.** Mid. Pleasant product, weak moat.

---

### F. Language-learning speaking practice

**Incumbents.** ELSA Speak (~$19.99/mo, $129.99/yr; phoneme-level feedback; complaints about inconsistent scoring, US-English bias, and users being charged a full year without consent after trials). Speak. TalkPal (~$6/mo, ~35 languages, shallower feedback). Duolingo.

**Why it's a bad fit for *your* assets.** Your model is trained on LibriSpeech — read, native, clean English. L2 learner speech is a severe domain mismatch. Pronunciation *scoring* needs phoneme-level alignment plus a scoring model you don't have. And a conversational partner needs an LLM → per-user cloud cost → ad revenue won't cover it.

**Verdict.** Low. Skip.

---

### G. Real-time translation chat

**Incumbents.** Google Translate — free, 249 languages, **offline packs for 50+**, conversation mode. SayHi (free, Amazon). iTranslate Pro (from $5.99/mo, 40+ offline languages). HI Translate ($29.99/yr). DuoDictum ($9.99/yr).

**Verdict.** Dead. The free incumbent already does offline, and you have neither an MT model nor TTS. Skip.

---

### H. Hands-free / driving-mode voice messaging

**Killed by the incumbent.** WhatsApp already ships **on-device** voice-message transcription globally (Settings → Chats → Voice Message Transcripts); Telegram Premium transcribes too. The residual complaints are about forwarded messages and unsupported languages — a thin seam, not a product.

**Verdict.** Low. Skip.

---

### I. Low-literacy / low-bandwidth voice-first messaging

Real global problem, genuine Peace Prize material. But your submission must be downloadable from the US, your reach in 8 weeks is a US Play listing, monetization is thin, and your model is English-only. Low for *this* hackathon; a good post-Shipaton direction.

---

## 3. Scoring the shortlist

Scale: 1–5. Weighted by what each award actually rewards.

| | **A. Caption rooms** | **B. Private meetings** | **C. Dictation** | **D. Field notes** | **E. Journaling** |
|---|---|---|---|---|---|
| **Grand Prize** (early ship + growth story) | 4 — emotional, shareable, an advocacy community that amplifies; multi-user invite loop is inherently viral | 3 — privacy angle is press-friendly but audience is slow-moving | 3 — installs come easy, story is dull | 2 — B2B pace | 3 |
| **Catvertising** (additive, non-interruptive) | **5** — "never an ad during a conversation, ads fund the archive" is a clean, defensible thesis | 3 | 3 | 2 — pro users hate ads | 4 |
| **OneSignal** (implementation + value + creativity) | **5** — push is load-bearing (room invites), plus IAM at the monetization moment | 3 | 2 — nothing to notify about | 3 | 3 |
| **Design Award** (innovation + aesthetics) | **5** — live captions are a typography/motion playground; per-speaker color, word-level reveal | 3 | 3 | 2 | 4 |
| **Peace Prize** | 5 | 2 | 4 | 1 | 2 |
| **Asset fit** (chat infra + streaming ASR both essential) | **5** | 2 | 2 | 2 | 2 |
| **8-week solo feasibility** | 3 — ASR export risk + realtime coordination | 4 | 5 | 4 | 4 |
| **Moat is real, not cosmetic** | **5** | 3 | 2 | 3 | 2 |

---

## 4. Ranked top 3

**1. Shared live-caption rooms for Deaf/HoH group conversation.**
The only candidate where both assets are load-bearing rather than decorative. Ava charges $9.99–14.99/month for *three hours* of premium captions and bills $4.99/hour beyond that — a price structure dictated entirely by cloud STT's per-minute cost. Google Live Transcribe is free but throws your transcripts away after three days and won't export them. On-device streaming ASR lets you offer what neither can: unlimited free captioning that also persists. The multi-device room turns your existing Supabase realtime layer into a diarization engine — each phone captions its own owner, so speaker attribution is free where competitors spend real ML effort. Ads never touch the live conversation; they fund the archive, which is both the ethically defensible position and the exact Catvertising thesis. Push notifications are functionally necessary (room invites), not bolted on. Real risk: it needs a genuinely streaming model.

**2. Private on-device meeting & lecture recorder.**
Otter's free tier is 300 minutes a month capped at 30 minutes a conversation with three lifetime imports, and the company is currently defending a federal class action alleging its notetaker recorded participants without consent and trained on the audio. "No bot joins your meeting, no audio leaves your phone, no minute limits" writes itself as positioning, and the build is the simplest on this list. But the latency half of your moat is unused, the summary feature that users actually want needs a cloud LLM you'd have to pay for, and phone-centric capture fights the fact that meetings happen on laptops. Solid, unexciting, safe.

**3. Android offline dictation + notes, aimed at people who find typing painful.**
The Android offline-transcription shelf is genuinely thin and every occupant is Whisper-based, meaning every one of them is press-speak-wait-read. Live word-by-word output is a visible, demoable difference. The catch is FUTO Voice Input: free, pay-what-you-want, well-regarded, and maintained by people who will not stop. Beating it needs a wedge beyond "also offline," and the honest wedge — latency — is thin. Best treated as a feature inside idea #1.

---

## 5. Single recommendation

**Build #1 — the live-caption product — but scope the MVP to single-device captioning first, and prove the ASR export before committing.**

The multi-device room is the differentiator and the Design/OneSignal story, but it is *not* what ships first. The first build is one phone, one microphone, live captions on screen, transcript saved and exportable. That's already better than Live Transcribe on the axis users complain about most, it validates the ASR path with the smallest possible surface area, and it gets something into testers' hands while the Play clock runs.

One adjustment after reading STREAM-ASR.md: **lead the marketing with the room, not the single phone.** Near-field own-voice capture is where your model is strong; a single phone straining to hear a noisy table is where test-other's 14–15% streaming WER shows up as a bad first impression. Ship single-device mode, but frame it as the fallback.

---

## 6. Eight-week plan

### ⛔ The critical path is Google Play, not the model

Your Play account is new, so the [12-testers-for-14-consecutive-days closed-testing rule](https://www.testerscommunity.com/blog/google-play-12-testers-policy) applies (it binds personal accounts created after 13 Nov 2023). Two things make it worse than it sounds:

1. The 14 days must be **unbroken and the most recent 14** at the moment you apply for production.
2. **Since April 2026 Google rejects production requests for insufficient tester *engagement*** — testers who opt in but never open the app don't count. Near-daily opens are the safe target. So you need 12 people who will actually use a captioning app daily for two weeks.

Backward math for a personal account:

| Date | Milestone |
|---|---|
| **~Aug 8** | Closed-testing track live, 12 testers opted in, app opens being logged |
| **~Aug 22** | 14 unbroken days complete → apply for production |
| **~Aug 25–28** | Realistic earliest **public** launch |

**So "ship publicly in week 1" is not achievable, and the brief's original plan was wrong about that.** Week 1 ships to *closed testing*. Public lands week 3–4 at best.

**The lever worth 3 weeks:** [organization accounts verified with a D-U-N-S number are exempt](https://www.choicely.com/blog/google-play-12-tester-rule) from the closed-testing requirement entirely. D-U-N-S numbers are free from Dun & Bradstreet but take roughly 1–2 weeks (sometimes faster) to issue, and Google's own verification adds days. If you can start that today it may still beat the closed-testing path — and it eliminates the "find 12 committed daily testers" problem, which is the part most likely to fail. **Evaluate this today; it's the highest-leverage hour in the whole project**, because Grand Prize criterion #1 is literally *when* you first shipped.

Whichever path: create the account and push a near-empty internal-testing build **this week**. That also unlocks IAP product creation, so RevenueCat can be wired before the app does anything.

### Week 0 (now) — export spike, before any product code

1. Load safetensors → PyTorch → export encoder / predictor / joiner to ONNX with explicit state in/out. **Timebox: 4 days.**
2. Decide the runtime fork early:
   - **(a) Conform to sherpa-onnx's `OnlineTransducerModel` contract.** Reshape your encoder state into its expected cached-tensor list. Costs the most upfront and inherits the most: Android AAR, JNI bindings, Silero VAD, endpoint detection, kaldi-native-fbank feature pipeline, and the punctuation model in the same runtime. **Try this first.**
   - **(b) ONNX Runtime Mobile directly**, with your own state plumbing and your own 80-bin log-mel + CMVN on Android. Full control, but you rebuild VAD, endpointing and features yourself. Fallback only.
3. int8-quantize. Re-run `Evaluate` on the quantized ONNX **on desktop first** and confirm WER hasn't collapsed — quantizing a transducer joiner can misbehave, and you have the eval harness to catch it.
4. Benchmark on a **mid-range** Android device, not a flagship. Measure RTF, first-partial latency, sustained thermals over a 30-minute session, and battery drain. A captioning app runs for an hour continuously; a 5-minute benchmark will lie to you.

**Kill criteria and pre-committed fallback.** If export or on-device RTF fights you past the 4-day box: **ship v1 on sherpa-onnx's pre-trained streaming Zipformer-EN, and swap STREAM ASR in post-launch.** The product thesis — on-device, unlimited, private, live — survives completely intact; only the "it's my own model" bragging right is deferred, and swapping it in later is a *better* growth story than never shipping. Decide this now, while it costs nothing to decide.

### Week 1 — thin but real, live in closed testing
Capacitor shell (**not** TWA — Play policy 4.3 rejects thin wrappers, and you need native mic, a foreground service, and the ONNX runtime). Single-device live captioning. Model **bundled in the APK or via Play Asset Delivery, not downloaded on first run** — FUTO's single most common user complaint is model-download failure; don't inherit it. Transcripts saved to Supabase. RevenueCat SDK with one product. AdMob account + one rewarded placement via `loadAndTrack`. OneSignal SDK + one campaign. OSS-licenses screen with the STREAM ASR NOTICE. Ugly is fine. **In testers' hands is the point.**

### Weeks 2–3 — the differentiator, and public launch
Multi-device caption rooms on your existing Supabase realtime layer. QR/link join. Per-speaker colour. Online punctuation + truecasing model in the pipeline. OneSignal transactional room-invite push. Production application goes in the moment the closed-testing clock allows.

### Weeks 4–5 — craft and ad economics
Design Award pass: word-level reveal animation, speaker-change transitions, scroll pinning, haptics, large-type accessibility mode, one-handed reachability. Rewarded-ad unlock for permanent save + PDF export, triggered by a OneSignal In-App Message at the save-limit moment. Supporter IAP removing ads.

### Weeks 6–8 — the growth story that actually wins the Grand Prize
r/deaf, r/HardOfHearing, r/HearingAids, HLAA chapters, Deaf TikTok, accessibility Mastodon, university disability-services offices. Instrument everything. #BuildInPublic threads throughout — a second award for work you're already doing. If the 600k-batch retrain has landed by now, ship it as a visible "accuracy update" and write up the before/after.

### Cut list (explicitly not in the 8 weeks)
iOS. Non-English. On-device LM rescoring. AI summarization. Hearing-aid / Bluetooth-mic routing. Sound-event detection (Live Transcribe's doorbell/dog-bark alerts). Cloud transcript sync beyond the room primitive.

---

## 7. Open questions — answer before committing

| # | Question | Why it's blocking |
|---|---|---|
| ~~Q1~~ | ~~Streaming or offline?~~ | **Answered: streaming, causal by construction, 320 ms chunk, one weight set.** Thesis holds. |
| ~~Q2~~ | ~~icefall or bespoke?~~ | **Answered: pure PyTorch, no k2/icefall.** Export is yours to write; see §1b Risk 5. |
| ~~Q3~~ | ~~Play account status?~~ | **Answered: new.** 12 testers × 14 days applies. See §6 — and evaluate the D-U-N-S organization-account exemption today. |
| **Q4** | Chat app framework (React/Vue/Svelte?) and does it already use a service worker? | Decides Capacitor migration effort. Recommendation is Capacitor regardless. |
| **Q8** | Which **specific mid-range Android device** is the benchmark target, and do you have one physically? | The week-0 RTF number is meaningless on an emulator or a flagship. This choice defines "does it work." |
| **Q9** | Can you name 12 people who will open a captioning app near-daily for 14 days? | If not, the D-U-N-S path isn't an optimization, it's the only path. |
| **Q5** | Does the free-trial/promo-code requirement apply to ads-only apps? Rules text reads universal; I found no exemption. | Sidestepped by the hybrid design (a cheap Supporter IAP satisfies it), but worth confirming in Discord. |
| **Q6** | How does RevenueCat count ad revenue for Grand Prize shortlisting? | RevenueCat Ads is **tracking-only and in beta**, and ad revenue explicitly does not contribute to RC billing — so it likely doesn't appear as "revenue" the way MRR does. Ask in Discord early; it may argue for keeping a real IAP in the mix. |
| **Q7** | Willing to also ship iOS? | Only matters for the Lawley/Productivity influencer award. Every category you named is Play-satisfiable. Recommendation: Play only. |

---

## 8. Where to put the assets

```
/home/peter/Documents/Codes/Other/Shipaton/
  chat-app/          # existing PWA, as-is
  stream-asr/        # the STREAM ASR repo (src/, config/, scripts/, tests/)
  stream-asr/models/ # transducer_avg.pt or .safetensors, cmvn.pt, bpe-500 tokenizer
  export/            # ONNX output lands here
```

For the week-0 spike I need, concretely:

- `transducer_avg.pt` (or the safetensors equivalent) — the averaged checkpoint everything decodes from
- the BPE-500 SentencePiece model + vocab
- `data/features/cmvn.pt`
- `config/model.yaml` and `config/decode.yaml` — chunk size, left context, `encoder_value_residual_lambda`, beam settings
- `src/slices/TrainAcousticModel/` and `src/slices/Decode/` — I need to read `ZipformerEncoder.streaming_forward()`'s actual state signature to design the ONNX state contract, plus `StatelessPredictor` and `TransducerJoiner`
- `src/shared_kernel/LogMel_Transform.py` — the feature frontend has to be reproduced bit-comparably on Android, or swapped for kaldi-native-fbank with matching parameters

STREAM-LM and the training scripts are not needed for the spike. Bring the repo whole if that's easier than cherry-picking.

---

## Sources

- [Shipaton 2026 official rules (Devpost)](https://revenuecat-shipaton-2026.devpost.com/rules) · [shipaton.com](https://www.shipaton.com/) · [Announcing Shipaton 2026](https://www.revenuecat.com/blog/company/announcing-shipaton-2026) · [Shipaton 2026 prep codelab](https://revenuecat.github.io/codelabs/shipaton-2026-prep.html) · [9to5Mac coverage](https://9to5mac.com/2026/08/04/revenuecat-shipaton-mobile-hackathon-is-back-with-1-million-worth-of-prizes/)
- [RevenueCat ad monetization docs](https://www.revenuecat.com/docs/ad-monetization) · [AdMob SDK integration](https://www.revenuecat.com/docs/ad-monetization/admob) · [Manual integration](https://www.revenuecat.com/docs/ad-monetization/manual-integration) · [Ads charts](https://www.revenuecat.com/docs/dashboard-and-metrics/charts/ads)
- [OneSignal Shipaton page](https://onesignal.com/shipaton)
- [Ava](https://www.ava.me/) · [Ava on Google Play](https://play.google.com/store/apps/details?id=me.ava.android) · [Ava raises $10M (Axios)](https://www.axios.com/2022/05/04/ava-live-caption-company-scores-10m) · [Ava alternative comparison](https://livetranscribe.pro/ava-alternative/)
- [Live Transcribe on Google Play](https://play.google.com/store/apps/details?id=com.google.audio.hearing.visualization.accessibility.scribe) · [Android accessibility help](https://support.google.com/accessibility/android/answer/9158064) · [Saving Live Transcribe texts](https://gotranscript.com/public/how-to-save-google-live-transcribe-texts-step-by-step-guide) · [Notta's Live Transcribe guide](https://www.notta.ai/en/blog/google-live-transcribe)
- [InnoCaption](https://www.innocaption.com/) · [Rylo](https://rylo.com/) · [Best caption apps for deaf users](https://livetranscribe.pro/best-caption-apps-for-deaf/) · [HLAA captioning resources](https://www.hearingloss.org/find-help/captioning/) · [AR captioning glasses review](https://www.hearingtracker.com/hearing-glasses/hear-with-your-eyes-five-ar-live-captioning-glasses)
- [Otter.ai pricing 2026](https://www.usecarly.com/blog/otter-ai-pricing/) · [Otter privacy class action](https://openclassactions.com/lawsuits/otter-ai-privacy-wiretap-class-action.php) · [The Register on the Otter suit](https://www.theregister.com/2025/08/18/otter_ml_privacy_lawsuit/) · [Fisher Phillips analysis](https://www.fisherphillips.com/en/insights/insights/new-lawsuit-highlights-concerns-about-ai-notetakers)
- [AudioPen alternatives / pricing](https://www.yaps.ai/blog/audiopen-alternative) · [Voicenotes vs AudioPen](https://speakwiseapp.com/blog/voicenotes-ai-vs-audiopen) · [Voice note app pricing compared](https://www.spokenplan.com/blog/voice-notes-pricing-compared)
- [FUTO Voice Input](https://voiceinput.futo.tech/) · [on Google Play](https://play.google.com/store/apps/details?id=org.futo.voiceinput) · [source mirror](https://github.com/futo-org/voice-input) · [review](https://privacygear.nl/en/reviews/futo-keyboard-review/)
- [Private Dictation: Offline AI](https://play.google.com/store/apps/details?id=org.mcmlv1.voicetotext) · [Speech to Text – ASR Offline](https://play.google.com/store/apps/details?id=com.ideastocode.speechtotext) · [Best offline transcription apps 2026](https://voicescriber.com/best-offline-transcription-apps)
- [ELSA Speak pricing](https://www.saasworthy.com/product/elsa-speak/pricing) · [ELSA review](https://learn.kotoenglish.com/blog/elsa-speak-review/) · [ELSA alternatives](https://www.talaera.com/business-english-platforms/elsa-speak-alternatives/)
- [Real-time translation app comparison](https://www.livelingo.io/guides/real-time-voice-translation-guide) · [Continuous translation apps](https://www.jotme.io/blog/best-continuous-translation-apps)
- [WhatsApp voice message transcripts](https://blog.whatsapp.com/introducing-voice-message-transcripts)
- [sherpa-onnx docs](https://k2-fsa.github.io/sherpa/onnx/index.html) · [streaming Zipformer transducer models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html) · [icefall ONNX export](https://k2-fsa.github.io/icefall/model-export/export-onnx.html) · [export-onnx-streaming.py](https://github.com/k2-fsa/icefall/blob/master/egs/librispeech/ASR/zipformer/export-onnx-streaming.py)
- [whisper.cpp Android streaming perf discussion](https://github.com/ggml-org/whisper.cpp/discussions/3567) · [Whisper streaming discussion](https://github.com/openai/whisper/discussions/2) · [Turning Whisper into a real-time system](https://arxiv.org/pdf/2307.14743) · [Picovoice on STT latency](https://picovoice.ai/blog/speech-to-text-latency/)
- [PWA vs Capacitor vs Native 2026](https://ourcodeworld.com/articles/read/3646/pwa-vs-capacitor-vs-native-2026) · [TWA vs Capacitor](https://saastostore.com/blog/twa-vs-capacitor) · [Capacitor audio recorder plugin](https://capawesome.io/docs/plugins/audio-recorder/)
- [Google Play 12-testers policy](https://www.testerscommunity.com/blog/google-play-12-testers-policy) · [The 12-tester rule explained, incl. D-U-N-S exemption](https://www.choicely.com/blog/google-play-12-tester-rule) · [Definitive 2026 guide](https://testerbee.com/blog/google-play-12-testers-closed-testing)
- [sherpa-onnx punctuation models](https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html) · [Edge-Punct-Casing](https://github.com/frankyoujian/Edge-Punct-Casing) · [Android AAR OnlinePunctuation issue #2568](https://github.com/k2-fsa/sherpa-onnx/issues/2568) · [sherpa-onnx repo](https://github.com/k2-fsa/sherpa-onnx)
