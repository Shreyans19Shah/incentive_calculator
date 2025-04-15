const bcrypt = require('bcrypt');

bcrypt.hash('PESB@14', 10, (err, hash) => {
    if (err) {
        console.error('Error generating hash:', err);
        return;
    }
    console.log('Generated hash:', hash);
});