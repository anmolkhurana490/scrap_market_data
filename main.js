import puppeteer from "puppeteer";
import axios from "axios";
import PdfParse from "pdf-parse";
import fs from "fs";
import { Parser } from "json2csv";

const CONFIG = {
    paths: {
        screener: 'https://www.screener.in/concalls/',
        login: 'https://www.screener.in/login/',
        outputFile: 'output.csv',
    },
    limits: {
        content: 10000,
        delay: 2500
    }
};


const extractCompanyData = async () => {
    const browser = await puppeteer.launch({
        headless: true,
    });

    const page = await browser.newPage();

    await page.goto(CONFIG.paths.login)
    await page.setViewport({ width: 1080, height: 1024 });

    await page.type('#id_username', process.env.SCREENER_USERNAME);
    await page.type('#id_password', process.env.SCREENER_PASSWORD);
    await page.click('button[type="submit"]', { delay: 1000 });

    // Wait and click on first result.
    await page.goto(CONFIG.paths.screener);

    const rows = (await page.$$('table#result_list tbody tr')); // Select all rows in the table body
    const companyData = await Promise.all(rows.map(async (row) => {
        const th = await row.$eval('th', el => el.textContent.trim());
        const tdLink = await row.$eval('td a', el => el.href.trim());
        return { name: th, link: tdLink };
    }));

    await browser.close();
    return companyData;
}

const extractPdf = async (link) => {
    try {
        const { data } = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 });
        if (data) {
            const pdf = await PdfParse(data);
            return pdf.text;
        }
        else {
            console.log('No data found in PDF', data);
            return '';
        }
    } catch (error) {
        console.error(`Error fetching PDF from ${link}:`, error.message);
        return '';
    }
};


async function analyzeWithGroq(content) {
    const prompt = `
        Given the following text, extract and return a JSON object with these keys:

        - QoQRevenue: Number (quarter-on-quarter revenue change)
        - YoYRevenue: Number (year-on-year revenue change)
        - QoQProfit: Number (quarter-on-quarter profit change)
        - YoYProfit: Number (year-on-year profit change)
        - events: Array of event names found in the text (from: Order Wins, Acquisition, Capex, New Product, Got Acquired, Govt Policy, QIP, Rights Issue, Fund Raise, Partnership, Diversification Plans, NCD, NCLT order, Bullish Analysts, Import/Export Tariffs, Demerger, Debt-Reduction)
        - prospects: One of "Challenging", "Good", or "Favorable/Excellent" (summarize management's outlook)

        Text:
        ${content.substring(0, CONFIG.limits.content)}
`;


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
                headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
                timeout: 30000
            }
        );

        return JSON.parse(response.data.choices[0].message.content);
    } catch (error) {
        console.error('Groq API error:', error.message);
        return null;
    }
}

const main = async () => {
    const data = await extractCompanyData();

    const summariedData = [];
    for (const company of data) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.limits.delay)); // Delay to avoid rate limiting

        console.log(`Processing company: ${company.name}`);
        const text = await extractPdf(company.link);

        if (text.length === 0) {
            console.log(`No text extracted for ${company.name}, skipping...`);
            continue;
        }

        const summary = await analyzeWithGroq(text);

        summariedData.push({
            name: company.name,
            ...summary
        });

        if (data.length == 10) break;
    }

    const fields = ['name', 'QoQRevenue', 'YoYRevenue', 'QoQProfit', 'YoYProfit', 'events', 'prospects'];
    const parser = new Parser({ fields });
    const csv = parser.parse(summariedData);

    fs.writeFileSync(CONFIG.paths.outputFile, csv);
    console.log(`Data saved to ${CONFIG.paths.outputFile}`);
}

main();