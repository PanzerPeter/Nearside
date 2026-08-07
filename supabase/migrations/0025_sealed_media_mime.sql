-- Storage has to accept the bytes 0024 started producing.
--
-- chat-media was created with a mime whitelist of image/video/audio types,
-- which was right while attachments went up as themselves. Since 0024 they go
-- up sealed, announced as application/octet-stream, and Storage rejected every
-- one of them with "mime type application/octet-stream is not supported" —
-- so no attachment could be sent at all.
--
-- The image types stay: chat backgrounds share this bucket and are not sealed.
-- The whitelist is no longer a meaningful control for the sealed objects (their
-- declared type says nothing about their contents), but file_size_limit still
-- applies, and that is the limit doing real work here.
update storage.buckets
   set allowed_mime_types = array[
         'application/octet-stream',
         'image/png',
         'image/jpeg',
         'image/webp',
         'image/gif'
       ]
 where id = 'chat-media';
