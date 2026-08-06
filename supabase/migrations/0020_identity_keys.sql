/*
  Nearside — published identity keys

  Contents:
    1. profiles.public_key   — X25519, base64. Used to seal messages TO this user.
    2. profiles.signing_key  — Ed25519, base64. Used to verify room messages FROM
                               this user (1:1 needs no separate signature —
                               crypto_box is already authenticated).
    3. profiles.key_updated_at — when the pair last changed.

  Why nullable:
    An account can exist before its device has generated an identity (signup
    completes, the app is killed before onboarding finishes). A NOT NULL here
    would make that state unrepresentable and the recovery path unwritable.

  Security notes:
    - These are PUBLIC halves. The seed they derive from never reaches this
      database, and there is no column here for it to arrive in.
    - Only the owner may write them; the existing narrowed SELECT policy from
      0008 already governs who may read them.
    - A key CHANGE is a security event, not an edit: key_updated_at is what
      lets a peer notice it and force re-verification.

  Why there is no new policy here:
    0001's profiles_update_own already reads
    USING (auth.uid() = id) WITH CHECK (auth.uid() = id) for authenticated,
    which covers these three columns the moment they exist — RLS is per row,
    not per column. A second permissive UPDATE policy would be OR'd with it and
    grant nothing, while adding a second place a future narrowing has to be
    remembered.
*/

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS public_key     text,
  ADD COLUMN IF NOT EXISTS signing_key    text,
  ADD COLUMN IF NOT EXISTS key_updated_at timestamptz;
