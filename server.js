const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Octokit } = require('@octokit/rest');

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });
const JWT_SECRET = process.env.JWT_SECRET || 'PESB@14';
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

app.use(express.static(__dirname));
app.use(express.json());

// Admin credentials
const ADMIN_CREDENTIALS = {
    username: 'Admin',
    password: '$2b$10$YDun1n93NNqBf1lf5AeoG.vWX.fp3KppLKXx5zqQX6AaRBRXWksJG' // Replace with your bcrypt hash
};

// Middleware to verify JWT
const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
};

// Login endpoint
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (username !== ADMIN_CREDENTIALS.username) {
        return res.status(401).json({ error: 'Invalid username' });
    }

    const passwordMatch = await bcrypt.compare(password, ADMIN_CREDENTIALS.password);
    if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
});

// RM calculator endpoint
app.post('/calculate-incentive', (req, res) => {
    try {
        const { name, previousIncome, newIncome, crossedSlab } = req.body;
        if (!name || previousIncome == null || newIncome == null || crossedSlab == null) {
            throw new Error('All fields are required');
        }

        const newBusinessValue = newIncome > previousIncome ? newIncome - previousIncome : 0;
        let incentive = 0;
        let remarks = '';

        if (newIncome > previousIncome && crossedSlab === 'Yes') {
            incentive = newBusinessValue * 0.20;
            remarks = 'You will receive an incentive';
        } else if (newIncome <= previousIncome) {
            remarks = 'New Income does not exceed Previous Income';
        } else {
            remarks = 'You have not crossed your slab';
        }

        const part1 = incentive * 0.70;
        const part2 = incentive * 0.30;

        res.json({
            name,
            incentiveAmount: incentive,
            part1,
            part2,
            remarks
        });
    } catch (error) {
        console.error('Error calculating incentive:', error);
        res.status(400).json({ error: error.message });
    }
});

// Protected upload endpoint
app.post('/upload', verifyToken, upload.fields([
    { name: 'trailIncomeFile', maxCount: 1 },
    { name: 'newBusinessFile', maxCount: 1 }
]), async (req, res) => {
    try {
        const trailFile = req.files['trailIncomeFile']?.[0];
        const newBusinessFile = req.files['newBusinessFile']?.[0];
        if (!trailFile || !newBusinessFile) {
            throw new Error('Both files are required');
        }

        const currentMonth = new Date().toISOString().slice(0, 7);
        console.log('Current Month:', currentMonth);

        // Read trail_income.xlsx
        const trailWorkbook = XLSX.readFile(trailFile.path);
        const trailSheetName = trailWorkbook.SheetNames[0];
        const trailWorksheet = trailWorkbook.Sheets[trailSheetName];
        const trailData = XLSX.utils.sheet_to_json(trailWorksheet);
        console.log('Trail Income Data:', trailData);

        // Read new_business.xlsx
        const newBusinessWorkbook = XLSX.readFile(newBusinessFile.path);
        const newBusinessSheetName = newBusinessWorkbook.SheetNames[0];
        const newBusinessWorksheet = newBusinessWorkbook.Sheets[newBusinessSheetName];
        const newBusinessData = XLSX.utils.sheet_to_json(newBusinessWorksheet);
        console.log('New Business Data:', newBusinessData);

        // Read slabs.xlsx
        const slabFilePath = path.join(__dirname, 'slabs.xlsx');
        if (!fs.existsSync(slabFilePath)) {
            throw new Error('slabs.xlsx not found');
        }
        const slabWorkbook = XLSX.readFile(slabFilePath);
        const slabSheetName = slabWorkbook.SheetNames[0];
        const slabWorksheet = slabWorkbook.Sheets[slabSheetName];
        const slabData = XLSX.utils.sheet_to_json(slabWorkbook);
        console.log('Slab Data:', slabData);

        // Read master_trail_income.xlsx from GitHub
        let masterData = [];
        try {
            const response = await octokit.repos.getContent({
                owner: process.env.GITHUB_OWNER,
                repo: process.env.GITHUB_REPO,
                path: 'app/trail-data/master_trail_income.xlsx'
            });
            const content = Buffer.from(response.data.content, 'base64');
            const masterWorkbook = XLSX.read(content, { type: 'buffer' });
            const masterSheetName = masterWorkbook.SheetNames[0];
            masterData = XLSX.utils.sheet_to_json(masterWorkbook.Sheets[masterSheetName]);
            console.log('Read master_trail_income.xlsx from GitHub');
        } catch (error) {
            if (error.status === 404) {
                console.log('master_trail_income.xlsx not found in repo at app/trail-data. Will create on write.');
            } else {
                console.error('Error reading from GitHub:', error.message);
                throw new Error('Failed to read master trail income data');
            }
        }
        console.log('Master Data before update:', masterData);

        // Calculate incentives
        const outputData = trailData.map(trailEntry => {
            const name = trailEntry['Name']?.trim();
            if (!name) return null;

            const trailIncome = trailEntry['Trail Income'] || 0;
            const newBusinessEntry = newBusinessData.find(row => row['Name']?.trim() === name);
            const newBusiness = newBusinessEntry ? (newBusinessEntry['New Business'] || 0) : 0;
            const slabEntry = slabData.find(row => row['Name']?.trim() === name);
            const slab = slabEntry ? (slabEntry['Slab'] || 0) : 0;

            const pastEntries = masterData.filter(row => row.Name === name);
            const previousHigh = pastEntries.length > 0 
                ? Math.max(...pastEntries.map(row => row['Trail Income'] || 0)) 
                : 0;

            const newBusinessValue = trailIncome > previousHigh ? trailIncome - previousHigh : 0;
            let incentive = 0;
            let remarks = '';

            if (trailIncome > previousHigh && newBusiness > slab) {
                incentive = newBusinessValue * 0.20;
                remarks = 'Incentive given';
            } else if (trailIncome <= previousHigh) {
                remarks = 'Trail Income does not exceed Previous High';
            } else {
                remarks = 'New Business does not exceed Slab Amount';
            }

            const part1 = incentive * 0.70;
            const part2 = incentive * 0.30;

            return { 
                Name: name, 
                'Incentive Amount': incentive, 
                Remarks: remarks,
                'Part 1 (70%)': part1,
                'Part 2 (30%)': part2
            };
        }).filter(row => row);

        // Append trail data to master and write to GitHub
        try {
            const newEntries = trailData.map(row => ({
                Name: row['Name']?.trim(),
                'Trail Income': row['Trail Income'] || 0,
                Month: currentMonth
            }));
            masterData.push(...newEntries);
            const masterWorkbook = XLSX.utils.book_new();
            const masterWorksheet = XLSX.utils.json_to_sheet(masterData);
            XLSX.utils.book_append_sheet(masterWorkbook, masterWorksheet, 'TrailIncome');
            const buffer = XLSX.write(masterWorkbook, { type: 'buffer' });
            const content = buffer.toString('base64');

            // Update or create file in GitHub
            const commitMessage = `Update master_trail_income.xlsx for ${currentMonth}`;
            try {
                const { data: { sha } } = await octokit.repos.getContent({
                    owner: process.env.GITHUB_OWNER,
                    repo: process.env.GITHUB_REPO,
                    path: 'app/trail-data/master_trail_income.xlsx'
                });
                await octokit.repos.createOrUpdateFileContents({
                    owner: process.env.GITHUB_OWNER,
                    repo: process.env.GITHUB_REPO,
                    path: 'app/trail-data/master_trail_income.xlsx',
                    message: commitMessage,
                    content,
                    sha
                });
                console.log('Updated master_trail_income.xlsx in GitHub at app/trail-data');
            } catch (error) {
                if (error.status === 404) {
                    await octokit.repos.createOrUpdateFileContents({
                        owner: process.env.GITHUB_OWNER,
                        repo: process.env.GITHUB_REPO,
                        path: 'app/trail-data/master_trail_income.xlsx',
                        message: commitMessage,
                        content
                    });
                    console.log('Created master_trail_income.xlsx in GitHub at app/trail-data');
                } else {
                    throw error;
                }
            }
        } catch (error) {
            console.error('Error writing to GitHub:', error.message);
            throw new Error('Failed to update master trail income data');
        }

        // Generate output Excel
        const outputWorkbook = XLSX.utils.book_new();
        const outputWorksheet = XLSX.utils.json_to_sheet(outputData);
        XLSX.utils.book_append_sheet(outputWorkbook, outputWorksheet, 'Incentives');
        const outputPath = path.join(__dirname, 'Uploads', 'incentive_output.xlsx');
        XLSX.writeFile(outputWorkbook, outputPath);

        // Send file
        res.download(outputPath, 'incentive_output.xlsx', (err) => {
            if (err) console.error('Error sending file:', err);
            fs.unlinkSync(outputPath);
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (req.files['trailIncomeFile']) fs.unlinkSync(req.files['trailIncomeFile'][0].path);
        if (req.files['newBusinessFile']) fs.unlinkSync(req.files['newBusinessFile'][0].path);
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://${process.env.NODE_ENV === 'production' ? 'Render URL' : 'localhost'}:${port}`);
});
