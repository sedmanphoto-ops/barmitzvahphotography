# barmitzvahphotography.com

Stephen Sedman Photography — Bar & Bat Mitzvah specialty site.

## Project Structure

```
barmitzvah-site/
├── index.html          # Home page
├── gallery.html        # Photo gallery (add real photos)
├── packages.html       # Pricing & packages
├── jewish-weddings.html # Jewish wedding photography
├── faq.html            # FAQ accordion
├── contact.html        # Contact form
├── styles/
│   └── main.css        # All styles
├── scripts/
│   └── main.js         # Nav, scroll, animations
├── public/             # Add images here
│   └── images/         # hero.jpg, stephen.jpg, gallery/*.jpg
└── vercel.json         # Vercel deployment config
```

## Deployment: GitHub → Vercel

### Step 1 — Initialize Git and push to GitHub

```zsh
cd ~/path/to/barmitzvah-site
git init
git add .
git commit -m "Initial site"
gh repo create barmitzvahphotography --public --source=. --push
```
(Install GitHub CLI with `brew install gh` if needed, then `gh auth login`)

### Step 2 — Deploy on Vercel

1. Go to https://vercel.com → "Add New Project"
2. Import your `barmitzvahphotography` GitHub repo
3. Framework Preset: **Other** (static site)
4. Root Directory: leave as `/`
5. Click **Deploy**

### Step 3 — Connect your custom domain

1. In Vercel → your project → Settings → Domains
2. Add `barmitzvahphotography.com`
3. Vercel will show you DNS records to add at your domain registrar
4. Add those records (usually 2: an A record and a CNAME)
5. DNS propagates in ~30 minutes

### Adding Photos

Replace the placeholder `<div class="gallery-placeholder">` elements with real `<img>` tags:

```html
<!-- Before -->
<div class="gallery-placeholder" style="height:320px"></div>

<!-- After -->
<img src="/public/images/gallery/bar-mitzvah-torah-reading.jpg" 
     alt="Bar Mitzvah Torah reading at Temple Beth Elohim, Wellesley"
     style="width:100%;display:block;" />
```

For the hero image, in `styles/main.css` find `.hero-img-placeholder` and replace background with:
```css
background-image: url('/public/images/hero.jpg');
background-size: cover;
background-position: center;
```

### Contact Form

The contact form needs a backend. Options:
- **Formspree** (easiest): Add `action="https://formspree.io/f/YOUR_ID"` to `<form>`
- **Netlify Forms**: Free if you switch to Netlify hosting
- **EmailJS**: JavaScript-based, no backend needed

### Future Enhancements
- [ ] Add real photography to all placeholder areas
- [ ] Connect contact form (Formspree recommended)
- [ ] Add Google Analytics (or Plausible for privacy-friendly)
- [ ] Add a Blog section for SEO
- [ ] Add Schema.org LocalBusiness structured data for SEO
- [ ] Consider adding Google Reviews widget
- [ ] Add Instagram feed embed
