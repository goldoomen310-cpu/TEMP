const KYOTO_API_V5 = 'https://app.kyotoplayer.com/api/v5';
const KYOTO_HEADERS = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'os-version': '35',
    'app-id': 'com.kyotoplayer',
    'app-version': '124'
};

async function test() {
    try {
        const response = await fetch(`${KYOTO_API_V5}/kai/player`, { headers: KYOTO_HEADERS });
        const text = await response.text();
        console.log(text.slice(0, 5000));
    } catch (e) {
        console.error(e);
    }
}
test();
