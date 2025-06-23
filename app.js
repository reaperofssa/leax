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
        await page.waitForTimeout(1000); // Add delay between scrolls
    }
};

// Helper: Parse date string to Date object for proper sorting
const parseDate = (dateStr) => {
    if (!dateStr) return new Date(0); // Very old date for null/undefined
    
    const now = new Date();
    const lowerDate = dateStr.toLowerCase().trim();
    
    // Handle relative dates
    if (lowerDate.includes('d ago')) {
        const days = parseInt(lowerDate.match(/(\d+)\s*d/)?.[1] || '0');
        return new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    }
    if (lowerDate.includes('w ago')) {
        const weeks = parseInt(lowerDate.match(/(\d+)\s*w/)?.[1] || '0');
        return new Date(now.getTime() - (weeks * 7 * 24 * 60 * 60 * 1000));
    }
    if (lowerDate.includes('mo ago')) {
        const months = parseInt(lowerDate.match(/(\d+)\s*mo/)?.[1] || '0');
        return new Date(now.getTime() - (months * 30 * 24 * 60 * 60 * 1000));
    }
    if (lowerDate.includes('y ago') || lowerDate.includes('yr ago')) {
        const years = parseInt(lowerDate.match(/(\d+)\s*y/)?.[1] || '0');
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
    
    // Query is contained in title
    if (title.includes(query)) {
        // Bonus for word boundaries
        const wordBoundaryRegex = new RegExp(`\\b${query}\\b`);
        return wordBoundaryRegex.test(title) ? 95 : 85;
    }
    
    // Check individual words
    const titleWords = title.split(/\s+/);
    const queryWords = query.split(/\s+/);
    let matchingWords = 0;
    
    queryWords.forEach(qWord => {
        if (titleWords.some(tWord => tWord.includes(qWord) || qWord.includes(tWord))) {
            matchingWords++;
        }
    });
    
    const wordMatchRatio = matchingWords / queryWords.length;
    return Math.floor(wordMatchRatio * 70);
};

// Main scraping function per site
async function scrapeSite(page, url, searchQuery = '') {
    try {
        console.log(`Scraping: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await autoScroll(page);
        await page.waitForSelector('.upcoming__table tbody', { timeout: 10000 });

        const rawData = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.upcoming__table tbody tr'));
            return rows.map(row => {
                const title = row.querySelector('td:nth-child(1)')?.innerText?.trim() || '';
                const date = row.querySelector('td:nth-child(2)')?.innerText?.trim() || '';
                const rawUrl = row.querySelector('td:nth-child(3) a')?.href || '';
                return { title, date, rawUrl };
            });
        });

        // Decode base64 links and calculate scores
        return rawData
            .map(item => {
                try {
                    const match = item.rawUrl?.match(/url1=([^&]+)/);
                    const base64 = match ? decodeURIComponent(match[1]) : '';
                    const decoded = base64 ? atob(base64) : null;
                    
                    return {
                        title: item.title,
                        date: item.date,
                        openLink: decoded,
                        parsedDate: parseDate(item.date),
                        score: searchQuery ? similarityScore(item.title, searchQuery) : 0
                    };
                } catch (err) {
                    console.error('Error decoding link:', err.message);
                    return {
                        title: item.title,
                        date: item.date,
                        openLink: null,
                        parsedDate: parseDate(item.date),
                        score: 0
                    };
                }
            })
            .filter(item => item.title && item.openLink); // Remove invalid entries
    } catch (err) {
        console.error(`Failed to scrape ${url}:`, err.message);
        return [];
    }
}

// Search endpoint with improved filtering
app.get('/scrape', async (req, res) => {
    const searchQuery = (req.query.query || '').toLowerCase().trim();
    
    if (!searchQuery) {
        return res.status(400).json({ error: 'Search query is required' });
    }
    
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

        // Filter results with better relevance scoring
        let filteredResults = allResults
            .filter(item => {
                // Must have a minimum relevance score
                if (item.score < 50) return false;
                
                // Additional filtering for better matches
                const titleLower = item.title.toLowerCase();
                const queryLower = searchQuery.toLowerCase();
                
                return titleLower.includes(queryLower) || item.score >= 70;
            })
            .sort((a, b) => {
                // Primary sort: relevance score (higher is better)
                if (b.score !== a.score) {
                    return b.score - a.score;
                }
                // Secondary sort: date (newer is better)
                return b.parsedDate.getTime() - a.parsedDate.getTime();
            });

        // Remove duplicates based on title similarity
        const uniqueResults = [];
        filteredResults.forEach(item => {
            const isDuplicate = uniqueResults.some(existing => 
                existing.title.toLowerCase() === item.title.toLowerCase() ||
                (existing.openLink && existing.openLink === item.openLink)
            );
            if (!isDuplicate) {
                uniqueResults.push(item);
            }
        });

        // Clean up the response (remove internal fields)
        const cleanResults = uniqueResults.slice(0, 25).map(item => ({
            title: item.title,
            date: item.date,
            openLink: item.openLink,
            score: item.score
        }));

        console.log(`Found ${cleanResults.length} results for "${searchQuery}"`);
        res.json(cleanResults);
    } catch (err) {
        console.error('Scraping failed:', err.message);
        res.status(500).json({ error: 'Scraping failed', details: err.message });
    } finally {
        await browser.close();
    }
});

// New route: Get 6 newest items across all sites
app.get('/newest', async (req, res) => {
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

        // Sort by date (newest first) and get top 6
        const newestResults = allResults
            .filter(item => item.title && item.openLink) // Valid entries only
            .sort((a, b) => b.parsedDate.getTime() - a.parsedDate.getTime())
            .slice(0, 6)
            .map(item => ({
                title: item.title,
                date: item.date,
                openLink: item.openLink
            }));

        console.log(`Found ${newestResults.length} newest items`);
        res.json(newestResults);
    } catch (err) {
        console.error('Failed to get newest items:', err.message);
        res.status(500).json({ error: 'Failed to get newest items', details: err.message });
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
    console.log(`  GET /scrape?query=<search_term> - Search for specific content`);
    console.log(`  GET /newest - Get 6 newest items`);
    console.log(`  GET /health - Health check`);
});
