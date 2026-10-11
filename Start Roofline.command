#!/bin/zsh
cd "${0:A:h}"
export PATH="/Users/parsasalahshori-a/.nvm/versions/node/v22.23.2/bin:$PATH"
if curl -fsS http://127.0.0.1:4311/api/health | /usr/bin/grep -q '"service":"roofline"'; then
  open http://127.0.0.1:4311/
  exit 0
fi
open http://127.0.0.1:4311/
exec npm start
