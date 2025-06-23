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
        await page.waitForTimeout(1000); // Wait between scrolls
    }
};

// Helper: Parse date string to comparable format
const parseDate = (dateStr) => {
    if (!dateStr) return new Date(0); // Very old date for null/undefined
    
    const now = new Date();
    const lower = dateStr.toLowerCase().trim();
    
    // Handle relative dates
    if (lower.includes('d ago')) {
        const days = parseInt(lower.match(/(\d+)\s*d\s*ago/)?.[1] || '0');
        return new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    }
    if (lower.includes('w ago')) {
        const weeks = parseInt(lower.match(/(\d+)\s*w\s*ago/)?.[1] || '0');
        return new Date(now.getTime() - (weeks * 7 * 24 * 60 * 60 * 1000));
    }
    if (lower.includes('mo ago')) {
        const months = parseInt(lower.match(/(\d+)\s*mo\s*ago/)?.[1] || '0');
        return new Date(now.getTime() - (months * 30 * 24 * 60 * 60 * 1000));
    }
    if (lower.includes('y ago')) {
        const years = parseInt(lower.match(/(\d+)\s*y\s*ago/)?.[1] || '0');
        return new Date(now.getTime() - (years * 365 * 24 * 60 * 60 * 1000));
    }
    
    // Try to parse as regular date
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? new Date(0) : parsed;
};

// Helper: Improved relevance scoring
const similarityScore = (title, query) => {
    if (!title || !query) return 0;
    
    title = title.toLowerCase().trim();
    query = query.toLowerCase().trim();
    
    // Exact match
    if (title === query) return 100;
    
    // Contains exact query
    if (title.includes(query)) return 95;
    
    // Check for partial matches
    const titleWords = title.split(/\s+/);
    const queryWords = query.split(/\s+/);
    
    let matchScore = 0;
    for (const queryWord of queryWords) {
        for (const titleWord of titleWords) {
            if (titleWord.includes(queryWord) || queryWord.includes(titleWord)) {
                matchScore += 20;
            }
        }
    }
    
    return Math.min(matchScore, 90);
};

// Main scraping function per site
async function scrapeSite(page, url, searchQuery = null) {
    try {
        console.log(`Scraping: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await autoScroll(page);
        await page.waitForSelector('.upcoming__table tbody', { timeout: 10000 });

        const rawData = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.upcoming__table tbody tr'));
            return rows.map(row => {
                const title = row.querySelector('td:nth-child(1)')?.innerText.trim();
                const date = row.querySelector('td:nth-child(2)')?.innerText.trim();
                const rawUrl = row.querySelector('td:nth-child(3) a')?.href;
                return { title, date, rawUrl };
            });
        });

        // Decode base64 links and calculate scores
        const results = rawData.map(item => {
            try {
                const match = item.rawUrl?.match(/url1=([^&]+)/);
                const base64 = match ? decodeURIComponent(match[1]) : '';
                const decoded = base64 ? atob(base64) : null;
                
                return {
                    title: item.title || 'Unknown',
                    date: item.date || 'Unknown',
                    openLink: decoded,
                    score: searchQuery ? similarityScore(item.title || '', searchQuery) : 0,
                    parsedDate: parseDate(item.date)
                };
            } catch (err) {
                console.error('Error decoding link:', err.message);
                return { 
                    title: item.title || 'Unknown', 
                    date: item.date || 'Unknown', 
                    openLink: null, 
                    score: 0,
                    parsedDate: parseDate(item.date)
                };
            }
        });

        return results.filter(item => item.title && item.title !== 'Unknown');
    } catch (err) {
        console.error(`Failed to scrape ${url}:`, err.message);
        return [];
    }
}

// Route for searching with query
app.get('/scrape', async (req, res) => {
    const searchQuery = req.query.query ? req.query.query.trim() : '';
    console.log(`Search query: "${searchQuery}"`);
    
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        const allResults = [];

        // Scrape all sites
        for (const site of TARGET_SITES) {
            const results = await scrapeSite(page, site, searchQuery);
            allResults.push(...results);
        }

        let finalResults = allResults;

        // If there's a search query, filter and sort by relevance
        if (searchQuery) {
            finalResults = allResults
                .filter(item => item.score > 0) // Only include items with relevance score
                .sort((a, b) => {
                    // First sort by score (relevance)
                    if (b.score !== a.score) return b.score - a.score;
                    // Then by date (newest first)
                    return b.parsedDate.getTime() - a.parsedDate.getTime();
                });
        } else {
            // No search query - sort by date only (newest first)
            finalResults = finalResults.sort((a, b) => b.parsedDate.getTime() - a.parsedDate.getTime());
        }

        // Remove parsedDate from response and limit results
        const responseResults = finalResults.slice(0, 25).map(item => ({
            title: item.title,
            date: item.date,
            openLink: item.openLink,
            score: item.score
        }));

        console.log(`Returning ${responseResults.length} results`);
        res.json(responseResults);
    } catch (err) {
        console.error('Scraping failed:', err.message);
        res.status(500).json({ error: 'Scraping failed', details: err.message });
    } finally {
        await browser.close();
    }
});

// New route for getting 6 newest items
app.get('/newest', async (req, res) => {
    console.log('Getting 6 newest items');
    
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        const allResults = [];

        // Scrape all sites
        for (const site of TARGET_SITES) {
            const results = await scrapeSite(page, site);
            allResults.push(...results);
        }

        // Sort by date (newest first) and take top 6
        const newestResults = allResults
            .sort((a, b) => b.parsedDate.getTime() - a.parsedDate.getTime())
            .slice(0, 6)
            .map(item => ({
                title: item.title,
                date: item.date,
                openLink: item.openLink
            }));

        console.log(`Returning ${newestResults.length} newest items`);
        res.json(newestResults);
    } catch (err) {
        console.error('Getting newest failed:', err.message);
        res.status(500).json({ error: 'Getting newest failed', details: err.message });
    } finally {
        await browser.close();
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Available endpoints:`);
    console.log(`  GET /scrape?query=<search_term> - Search for items`);
    console.log(`  GET /newest - Get 6 newest items`);
    console.log(`  GET /health - Health check`);
});
