# Operator runbook

For whoever runs the server at `https://ac.lan`. This covers setup, accounts, running and resetting exercises, backups and restores, and updates. The design and the full reference are in the README's "Deployment (Docker / Podman)" and "Exercises and cells" sections.

Every command runs in the repository folder on the server (e.g. `/srv/ipb`) with these variables set, for example in `/srv/ipb/.env`, which Compose reads on its own:

```bash
IPB_DATA_DIR=/srv/ipb-data        # the packed reference data (read-only)
IPB_BACKUP_DIR=/srv/ipb-backups   # where backups land
# IPB_STATE_DIR=/srv/ipb-state    # optional: live data in a host folder instead of a Docker volume (must be owned by uid 1000)
```

## 1. First setup (once)

1. **Server:** Docker with the compose plugin (or Podman 4+). Ports 80 and 443 must be free.
2. **Name:** on the router, point `ac.lan` at the server's LAN address.
3. **Reference data:** on the machine that built it, run `deploy/pack-data.sh /srv/ipb-data` (or `user@server:/srv/ipb-data`). This copies about 29 GB and never the build caches. Re-running it later copies only what changed.
4. **Code:** `git clone <repo> /srv/ipb && cd /srv/ipb`.
5. **Admin password:**
   ```bash
   mkdir -p deploy/secrets
   printf '%s' 'a strong password' > deploy/secrets/admin_password
   chmod 600 deploy/secrets/admin_password
   sudo chown 1000 deploy/secrets/admin_password
   ```
6. **Backup folder:** the backup container runs as uid 1000, so it must be able to write there: `sudo mkdir -p /srv/ipb-backups && sudo chown 1000 /srv/ipb-backups`.
7. **Start:** `docker compose up -d --build --wait`. It's done when `docker compose ps` shows `app` and `caddy` as `healthy`.
8. **Check the data:** `curl -k https://ac.lan/healthz` must list every file as `true`. A `false` means that file is missing under `IPB_DATA_DIR`.
9. **First sign-in:** browse to `https://ac.lan` and sign in as `admin` with the password from step 5. The app then makes you choose a new one. Keep `deploy/secrets/admin_password` (mode 600): Compose refuses to start without it, but the app reads it only while no users exist, so after the first sign-in it no longer opens anything.
10. **Clients:** each computer, tablet or phone installs the certificate once, from `http://ac.lan/ca.crt` (steps per OS are in the README, "First start", step 4). Without it, browsers warn that the connection is not private.
11. **Backups:** schedule them (section 5) before the first real exercise.
12. **Load test:** optional, but worth doing on new hardware (section 8).

## 2. Accounts

| Where                   | What                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin → **Users**       | Create an account with a temporary password; the user must change it at first sign-in. Also: disable, reset password (temporary again), sign out everywhere, delete, admin flag. |
| Admin → **Members**     | Cell (White/Blue/Red) and role for the _current_ exercise, per user or several at once. An account without a membership can sign in but opens nothing.                           |
| Admin → **Audit trail** | Who changed what, when.                                                                                                                                                          |

**Cells.** White (EXCON) sees everything, runs the clock and injects, answers RFIs, and can hand an item to another cell. Blue and Red see their own cell's items plus what was released to them. Released items are read-only for the receiving cell.

**Roles**, lowest to highest: observer (read), analyst (create and edit), collection-manager (collection plan), game-master (clock, injects, scenario). Each role includes the ones below it.

**Keep admins in White.** The admin flag sees every cell no matter which cell the admin is a member of.

The same from the shell:

```bash
docker compose exec app node server/tools/users.mjs list
docker compose exec -T app node server/tools/users.mjs add jnovak --password-stdin <<< 'temporary password'
docker compose exec app node server/tools/users.mjs member jnovak --cell blue --role analyst
docker compose exec -T app node server/tools/users.mjs passwd jnovak --password-stdin <<< 'new password'
```

A password or account change made from the shell reaches that user's open browser tabs within 25 s. A change made on the Admin page takes effect immediately.

## 3. Day of an exercise

1. `docker compose ps`: both containers `healthy`.
2. Run a backup (section 5) before users arrive.
3. Admin → Members: everyone has a cell and role.
4. White sets the scenario clock, and schedules injects with their **Release to** cells.
5. During the exercise: `docker stats ipb-app-1` shows the load. The load test (section 8) gives the normal range.

## 4. Between exercises

Admin → **Exercise**:

- **Archive now:** a snapshot of all studies, ORBATs and exercise data, plus the member list. Take one at the end of each exercise, for the after-action review.
- **Reset exercise:** you type the current name to confirm. The reset archives automatically, empties all studies, ORBATs and exercise data, and clears every membership. Accounts, equipment bookmarks and reference data stay. Afterwards assign members again (Members tab). Users' open tabs reload by themselves.
- **Restore:** brings back an archived exercise and archives the current one first. Members are restored for accounts that still exist.

During a reset or restore, other requests get "Exercise is being reset" for a few seconds.

## 5. Backups

```bash
docker compose --profile backup run --rm backup
```

This writes `IPB_BACKUP_DIR/<time>/` (all databases, consistent even while people are working) and keeps the newest 14 (`IPB_BACKUP_KEEP`). It also copies exercise archives into `IPB_BACKUP_DIR/archives/`, which is never rotated.

**Schedule** a backup every 2 hours on the host (`crontab -e` as a user in the `docker` group):

```cron
0 */2 * * * cd /srv/ipb && docker compose --profile backup run --rm backup >> /srv/ipb-backups/backup.log 2>&1
```

**Copy `IPB_BACKUP_DIR` off the server** (NAS, USB disk). A backup kept only on the same disk does not survive a disk failure.

## 6. Restore

```bash
docker compose stop app
docker compose --profile backup run --rm --entrypoint node backup server/tools/restore.mjs              # list backups
docker compose --profile backup run --rm --entrypoint node backup server/tools/restore.mjs <backup>     # dry run: what would change
docker compose --profile backup run --rm --entrypoint node backup server/tools/restore.mjs <backup> --yes
docker compose start app
```

- Every file is integrity-checked before anything is touched.
- The current state is saved to `IPB_BACKUP_DIR/pre-restore-<time>/`, which you can restore the same way to undo.
- `--only auth` restores just the accounts; `--only ipb,exercise,orbat` restores just the exercise.
- The tool refuses while the app is running, because the databases' `-wal`/`-shm` files still exist. After a crash, and only then, add `--force`.
- Users must sign in again only if `auth` was restored.

**Drill:** do this once before the first exercise (done on the pilot install and again on the first real install, 26 Sep 2026: the restore removed the test study, and restoring `pre-restore-*` brought it back). Take a backup, create a test study, restore the backup, and check that the study is gone. Then restore the `pre-restore-*` folder and check that the study is back.

## 7. Updates

```bash
git pull
docker compose up -d --build --wait
```

Database migrations run by themselves. Run a backup first. After updating reference data on the build machine, run `deploy/pack-data.sh` again; the app picks up rebuilt files without a restart.

## 8. Load test

With the stack running, from any machine that has Node 22+ and the CA:

```bash
IPB_LOADTEST_ADMIN_PASSWORD='<admin password>' NODE_EXTRA_CA_CERTS=ca.crt \
  node deploy/loadtest.mjs --url https://ac.lan --users 30 --minutes 5
```

It simulates 30 users: live updates, map panning (basemap, satellite and hillshade tiles), list refreshes, a report every 20–45 s per analyst, and a viewshed every 1–2.5 min per analyst. It prints latency per request kind, and removes its users and reports at the end. Run it before an exercise, never during one.

Run it from **another machine on the LAN**, as the clients will connect. Run on the server itself, its connections go through Docker's port proxy instead of the network path clients use, and the tile tail latencies come out several times worse than clients will see (measured on the first install, 26 Sep 2026: p95 3–4 s from the server itself, 0.7–1.3 s for the same burst inside Docker's network).

Reference results: 30 users (2 White, 14 Blue, 14 Red) for 5 minutes, through Caddy. The host had 32 cores, but the app was capped at 6 CPUs by `compose.yaml`, and 4 terrain workers ran, as on an 8-core server.

| Request                                                  | Count | p50   | p95    | max    |
| -------------------------------------------------------- | ----- | ----- | ------ | ------ |
| lists (studies, reports, requirements, tracks, messages) | 7,925 | 5 ms  | 14 ms  | 34 ms  |
| saving a report                                          | 218   | 2 ms  | 5 ms   | 16 ms  |
| satellite tiles                                          | 6,876 | 10 ms | 690 ms | 1.2 s  |
| vector basemap reads                                     | 5,157 | 19 ms | 745 ms | 1.2 s  |
| hillshade tiles (drawn on demand)                        | 6,876 | 16 ms | 1.4 s  | 4.6 s  |
| viewshed, 3–10 km radius                                 | 69    | 2.6 s | 8.5 s  | 11.4 s |

- **Errors:** none. No request was turned away as busy (429 or 503).
- **Live updates:** a report reached the other members of its cell in 3 ms at p50 and 17 ms at worst.
- **Classroom start:** all 30 users loading the map at the same moment took 4.7 s.
- **Peak use:** the app used 3.1 CPUs and 1.2 GB of memory; Caddy used under 250 MB.

What to expect:

- **Map tiles** are slow only at the tail, when every user pans at the same moment. The test pans each user to a random spot, which is harsher than a class working in one area, where tiles already drawn for one user come from cache for everyone else.
- **Viewsheds** are the slowest part. Analyses run on at most 3 of the 4 terrain workers, because one is kept free for map tiles, so a burst of large viewsheds queues. If several analysts routinely wait more than about 10 s, raise the workers to 6: add `IPB_TERRAIN_WORKERS: '6'` under the `app` service's `environment:` in `compose.yaml` (an entry in `.env` alone does not reach the container). That costs about 384 MB of memory per extra worker (`modules/terrain/server/pool.js`) and fits the 8 GB limit.

## 9. Troubleshooting

See the README's troubleshooting table. The most common problems:

- **"Connection not private":** the certificate isn't installed on that device, or the address used was the IP instead of `https://ac.lan`.
- **`app` unhealthy:** check `docker compose logs app` and `curl -k https://ac.lan/healthz`.
- **A user sees an empty app:** they have no membership in the current exercise (Admin → Members).
- **"Too many terrain analyses running for this account":** that user already has a viewshed or MCOO running plus one queued. Wait for one to finish.
