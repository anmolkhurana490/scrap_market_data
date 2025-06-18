import puppeteer from 'puppeteer-core';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import YoutubeTranscript from 'youtube-transcript';


// Configuration
const CONFIG = {
    groqApiKey: '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',
    wpApiUrl: 'https://profitbooking.in/wp-json/stock/v1/screener',
    credentials: {
        email: 'sentobirl@gmail.com',
        password: 'sento@129025'
    },
    paths: {
        output: path.join(__dirname, 'analysis_reports'),
        processed: path.join(__dirname, 'processed_companies.json')
    },
    limits: {
        content: 10000,
        retries: 3,
        delay: 2000
    }
};


// Initialize system
!fs.existsSync(CONFIG.paths.output) && fs.mkdirSync(CONFIG.paths.output);
let processedCompanies = loadProcessedCompanies();


function loadProcessedCompanies() {
    try {
        return fs.existsSync(CONFIG.paths.processed) ?
            JSON.parse(fs.readFileSync(CONFIG.paths.processed)) : [];
    } catch (error) {
        console.error('Error loading processed companies:', error.message);
        return [];
    }
}


function saveProcessedCompany(company) {
    if (!processedCompanies.includes(company)) {
        processedCompanies.push(company);
        fs.writeFileSync(CONFIG.paths.processed, JSON.stringify(processedCompanies));
    }
}


function sanitizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 50);
}


async function getTranscriptContent(link) {
    try {
        const videoId = link.match(/(?:v=|\/)([\w-]{11})/)[1];
        const transcript = await YoutubeTranscript.fetchTranscript(videoId);
        return transcript.map(t => t.text).join('\n');
    } catch (error) {
        console.error('YouTube error:', error.message);
        return null;
    }
}


async function getPdfContent(link) {
    try {
        const { data } = await axios.get(link, { responseType: 'arraybuffer' });
        const pdf = await pdfParse(data);
        return pdf.text;
    } catch (error) {
        console.error('PDF error:', error.message);
        return null;
    }
}


async function analyzeWithGroq(companyName, content) {
    const prompt = `Extract financial metrics as JSON:
{
  "symbol": "NSE symbol",
  "revenue_growth": "Revenue Growth",
  "profit_growth": "Profit Growth",
  "report_date": "DD-MM-YYYY",
  "opportunities": ["future growth points"],
  "risks": ["risk points"]
}


Content: ${content.substring(0, CONFIG.limits.content)}`;


    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'deepseek-r1-distill-llama-70b',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1,
                response_format: { type: 'json_object' }
            },
            {
                headers: { Authorization: `Bearer ${CONFIG.groqApiKey}` },
                timeout: 30000
            }
        );
        return JSON.parse(response.data.choices[0].message.content);
    } catch (error) {
        console.error('Groq API error:', error.message);
        return null;
    }
}


async function storeData(payload) {
    try {
        console.log('Sending payload:', JSON.stringify(payload, null, 2));

        const response = await axios.post(CONFIG.wpApiUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        console.log('API Response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Storage API error:', {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message
        });
        return null;
    }
}


async function processCompany(entry) {
    const cleanName = sanitizeName(entry.companyName);
    if (processedCompanies.includes(cleanName)) {
        console.log(`Skipping: ${entry.companyName}`);
        return;
    }


    console.log(`Processing: ${entry.companyName}`);

    try {
        const content = entry.link.includes('youtube')
            ? await getTranscriptContent(entry.link)
            : await getPdfContent(entry.link);


        if (!content) {
            console.log('No content found');
            return;
        }


        const analysis = await analyzeWithGroq(entry.companyName, content);
        if (!analysis) return;


        const payload = {
            company: entry.companyName,
            symbol: analysis.symbol || 'N/A',
            revenue_growth: analysis.revenue_growth || '0%',
            profit_growth: analysis.profit_growth || '0%',
            report_date: analysis.report_date || new Date().toISOString().split('T')[0],
            opportunities: analysis.opportunities || [],
            risks: analysis.risks || [],
            source_url: entry.link,
            confidence_score: Math.floor(Math.random() * 100) // Temporary score
        };


        const result = await storeData(payload);
        if (result) {
            saveProcessedCompany(cleanName);
            fs.writeFileSync(
                path.join(CONFIG.paths.output, `${cleanName}.json`),
                JSON.stringify(payload, null, 2)
            );
            console.log(`Stored data for ${entry.companyName}`);
        }
    } catch (error) {
        console.error(`Process failed: ${error.message}`);
    }
}


(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(120000);


        // Login handling
        await page.goto('https://www.screener.in/login/?next=/concalls/', {
            waitUntil: 'networkidle2',
            timeout: 120000
        });


        // Debug screenshot
        await page.screenshot({ path: 'login-page.png' });


        // Login flow
        await page.type('#id_username', CONFIG.credentials.email, { delay: 100 });
        await page.type('#id_password', CONFIG.credentials.password, { delay: 100 });

        await Promise.all([
            page.waitForNavigation({ timeout: 120000 }),
            page.click('button[type="submit"]')
        ]);


        // Verify login
        await page.waitForSelector('.field-action_display', { timeout: 30000 });

        // Get target date data
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 1);
        const formattedDate = targetDate.toLocaleDateString('en-GB', {
            day: '2-digit', month: 'long', year: 'numeric'
        }).replace(/ /g, ' ');


        const entries = await page.$$eval('.field-action_display', (sections, targetDate) => {
            return sections.map(section => {
                const row = section.closest('tr');
                return {
                    companyName: row.querySelector('.field-company_display span').textContent.trim(),
                    link: section.querySelector('a').href,
                    date: row.querySelector('.field-pub_date').textContent.trim()
                };
            }).filter(entry => entry.date === targetDate);
        }, formattedDate);


        console.log(`Found ${entries.length} entries`);


        // Process entries
        for (const entry of entries) {
            await processCompany(entry);
            await new Promise(r => setTimeout(r, CONFIG.limits.delay));
        }


    } catch (error) {
        console.error('Main error:', error.message);
        await page.screenshot({ path: 'error.png' });
    } finally {
        await browser.close();
        console.log('Process completed');
    }
})();
