const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgres://user:pass@postgres:5432/outline',
  ssl: false
});

client.connect()
  .then(() => {
    console.log('Connected to database successfully using individual params!');
    return client.query('SELECT NOW()');
  })
  .then(res => {
    console.log('Current time from DB:', res.rows[0]);
    process.exit(0);
  })
  .catch(err => {
    console.error('Failed to connect:', err);
    process.exit(1);
  });
