const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\nAdd these to your environment variables (.env or your host\'s dashboard):\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\nKeep the private key secret. The public key is safe to expose to the browser.\n');
