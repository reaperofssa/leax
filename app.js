const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const atob = require('atob');
const app = express();
const PORT = process.env.PORT || 7860;

puppeteer.use(StealthPlugin());

// Add all your scraping target URLs
const TARGET_SITES = [
    'https://leak.sx/dispenser_streaming.php',
    'https://leak.sx/dispenser_music.php',
    'https://leak.sx/dispenser_gaming.php',
    'https://leak.sx/dispenser_vpn.php',
    'https://leak.sx/dispenser_other.php'
];

// Helper: Scroll slowly and load more rows
const autoScroll = async (page) => {
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, 500));
    }
};

// Helper: Score relevance
const similarityScore = (title, query) => {
    title = title.toLowerCase();
    query = query.toLowerCase();
    if (title === query) return 100;
    if (title.includes(query)) return 90;
    const distance = Math.abs(title.length - query.length);
    return 70 - distance;
};

// Main scraping function per site
async function scrapeSite(page, url, searchQuery) {
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });
        await autoScroll(page);
        await page.waitForSelector('.upcoming__table tbody');

        const rawData = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.upcoming__table tbody tr'));
            return rows.map(row => {
                const title = row.querySelector('td:nth-child(1)')?.innerText.trim();
                const date = row.querySelector('td:nth-child(2)')?.innerText.trim();
                const rawUrl = row.querySelector('td:nth-child(3) a')?.href;
                return { title, date, rawUrl };
            });
        });

        // Decode base64 links
        return rawData.map(item => {
            try {
                const match = item.rawUrl?.match(/url1=([^&]+)/);
                const base64 = match ? decodeURIComponent(match[1]) : '';
                const decoded = atob(base64);
                return {
                    title: item.title,
                    date: item.date,
                    openLink: decoded,
                    score: searchQuery ? similarityScore(item.title || '', searchQuery) : 0
                };
            } catch {
                return { title: item.title, date: item.date, openLink: null, score: 0 };
            }
        });
    } catch (err) {
        console.error(`Failed to scrape ${url}`, err.message);
        return [];
    }
}

app.get('/scrape', async (req, res) => {
    const searchQuery = (req.query.query || '').toLowerCase();
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        const allResults = [];

        for (const site of TARGET_SITES) {
            const results = await scrapeSite(page, site, searchQuery);
            allResults.push(...results);
            if (allResults.length >= 25) break;
        }

        let finalResults = allResults.slice(0, 25);

        if (searchQuery) {
            finalResults = finalResults
                .filter(item => item.title?.toLowerCase().includes(searchQuery) || item.score > 60)
                .sort((a, b) => b.score - a.score);
        }

        // Sort by date descending (if available, or fallback to current order)
        finalResults = finalResults.sort((a, b) => {
            return new Date(b.date || '2000-01-01') - new Date(a.date || '2000-01-01');
        });

        res.json(finalResults.slice(0, 25));
    } catch (err) {
        console.error('Scraping failed:', err.message);
        res.status(500).json({ error: 'Scraping failed' });
    } finally {
        await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
