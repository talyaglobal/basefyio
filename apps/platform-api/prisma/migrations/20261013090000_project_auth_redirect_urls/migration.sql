-- Social sign-in may only return the browser to a URL the project registered.
-- Until d05d035 the callback dropped every absolute redirect_to, so a customer
-- app on its own host never received the tokens; following it unchecked would
-- instead hand an account to whatever host the (browser-supplied) OAuth state
-- named. This column is that allowlist.
ALTER TABLE "project_auth_configs"
  ADD COLUMN "redirect_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
