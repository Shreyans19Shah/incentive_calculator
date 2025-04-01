const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

const upload = multer({ dest: 'uploads/' });

app.use(express.static(__dirname));

app.post('/upload', upload.single('excel'), (req, res) => {
    try {
        // Get the name from the form data
        const name = req.body.name;
        console.log('Received Name:', name);

        // Read uploaded trail_income.xlsx
        console.log('File received:', req.file);
        const trailWorkbook = XLSX.readFile(req.file.path);
        const trailSheetName = trailWorkbook.SheetNames[0];
        const trailWorksheet = trailWorkbook.Sheets[trailSheetName];
        const trailData = XLSX.utils.sheet_to_json(trailWorksheet);
        console.log('Trail Income Data:', trailData);

        // Find matching trail income
        const trailEntry = trailData.find(row => row['Name'] === name);
        const trailIncome = trailEntry ? trailEntry['Trail Income'] || 0 : 0;
        console.log('Extracted Trail Income for', name, ':', trailIncome);

        // Read slabs.xlsx from backend
        const slabFilePath = path.join(__dirname, 'slabs.xlsx');
        if (!fs.existsSync(slabFilePath)) {
            throw new Error('slabs.xlsx not found in backend');
        }
        const slabWorkbook = XLSX.readFile(slabFilePath);
        const slabSheetName = slabWorkbook.SheetNames[0];
        const slabWorksheet = slabWorkbook.Sheets[slabSheetName];
        const slabData = XLSX.utils.sheet_to_json(slabWorksheet);
        console.log('Slab Data:', slabData);

        // Find matching slab
        const slabEntry = slabData.find(row => row['Name'] === name);
        const slab = slabEntry ? slabEntry['Slab'] || 0 : 0;
        console.log('Extracted Slab for', name, ':', slab);

        // Send both values back
        res.json({ trailIncome, slab });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});