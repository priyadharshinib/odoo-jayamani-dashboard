# Local first, then Git, then Netlify

## 1. Run tests (no Odoo/Netlify needed)
    npm install
    npm test

## 2. Run the site locally (real Odoo data)
    copy .env.example to .env and fill in your values (new Odoo API key)
    npm run dev          -> opens http://localhost:8888
Sign in with ADMIN_USER / ADMIN_PASS from .env. Needs Node 18+.

## 3. Push to Git (.env is ignored, so your key is never uploaded)
    git init
    git add .
    git commit -m "Odoo dashboard"
    git branch -M main
    git remote add origin https://github.com/<you>/<repo>.git
    git push -u origin main

## 4. Netlify
Import the repo, then add the same 6 variables from .env under
Project configuration > Environment variables, and redeploy.

Roles live in PERM at the top of netlify/functions/api.mjs.
