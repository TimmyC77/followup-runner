# followup-runner

When a Vikunja task is marked done and has an **On completion** section, Vikunja sends a webhook. This service then runs a locked-down headless Claude Code session to carry out the follow-up. It runs on claude-ops (CT 119).

Full docs, safety design and install steps: Outline → Proxmox › claude-ops (CT 119) › **Follow-up runner (CT 119)**.

## Install on claude-ops (as root)

```bash
git clone git@github.com:TimmyC77/followup-runner.git /opt/followup-runner
useradd --system --no-create-home --shell /usr/sbin/nologin followup
cp /opt/followup-runner/.env.example /opt/followup-runner/.env
chown -R root:followup /opt/followup-runner && chmod 640 /opt/followup-runner/.env
# Fill in .env yourself; never commit it.
cp /opt/followup-runner/deploy/followup-runner.service /etc/systemd/system/
systemctl daemon-reload
```

Update: `cd /opt/followup-runner && git pull && systemctl restart followup-runner`

Test locally (fake Claude, no network): `node test.mjs`
