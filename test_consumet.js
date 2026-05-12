const fetch = require('node-fetch');

async function testConsumet() {
    const title = "One Piece";
    try {
        const res = await fetch(`https://api-consumet-org-taupe.vercel.app/anime/gogoanime/${encodeURIComponent(title)}`);
        const data = await res.json();
        console.log(JSON.stringify(data.results[0], null, 2));
    } catch(e) {
        console.error(e);
    }
}
testConsumet();
