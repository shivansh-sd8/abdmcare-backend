import axios from 'axios';

const BASE_URL = 'http://localhost:3000';

async function testLogin() {
  try {
    const response = await axios.post(`${BASE_URL}/api/v1/auth/login`, {
      email: 'test@example.com',
      password: 'password123',
    });

    console.log('✅ Login successful!');
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } catch (error: any) {
    if (error.response) {
      console.log('❌ Login failed with response:');
      console.log('Status:', error.response.status);
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.code === 'ECONNREFUSED') {
      console.log('❌ Server is not running. Start it with: npm run dev');
    } else {
      console.log('❌ Error:', error.message);
    }
  }
}

testLogin();
