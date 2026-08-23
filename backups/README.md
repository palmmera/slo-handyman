# Database Backups

This folder contains manual backups of the production database from Render.

## Files

- `db-backup-YYYY-MM-DD.json` - Full database snapshots from `/data/db.json` on Render

## What's included

Each backup contains:
- All handymen profiles (contact info, Stripe accounts, rates, bios, photos)
- All jobs and bookings (payments, statuses, reviews)
- All user accounts and sessions
- Custom job requests and contact form submissions

## How to restore

If the Render disk fails or data is lost:

1. SSH into Render shell (or use the Shell tab in dashboard)
2. Stop the app temporarily (optional, but safer)
3. Upload the backup file to `/data/db.json`:
   ```bash
   cat > /data/db.json
   # Paste the backup JSON contents
   # Press Ctrl+D when done
   ```
4. Restart the app if you stopped it

## Backup schedule

**Current:** Manual backups when remembered

**Recommended:** 
- Weekly backups while getting started
- Daily backups once you have 50+ handymen or active bookings
- Migrate to Postgres with automatic backups if revenue grows

## Security

**DO NOT commit this folder to GitHub.** It contains:
- Real customer emails and phone numbers
- Password hashes
- Stripe account IDs and tokens
- Session tokens

The folder is already in `.gitignore`.
