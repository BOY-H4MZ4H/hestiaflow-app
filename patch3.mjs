// Alat tempel SEKALI PAKAI (dihapus workflow setelah jalan): contoh curl di
// public/app2.js kini mengikuti baseUrl resmi dari settings (bukan domain lama).
import { readFileSync, writeFileSync } from 'node:fs';
const B64 = [
  "W1siICAgICAgPGRpdiBjbGFzcz1cInRlcm1ib3hcIiBzdHlsZT1cIm92ZXJmbG93OmF1dG9cIj48cHJlIGlkPVwiY3VybEV4YW1wbGVcIiBzdHlsZT1cIm1h",
  "cmdpbjowO3doaXRlLXNwYWNlOnByZTtmb250LXNpemU6MTNweFwiPmN1cmwgaHR0cHM6Ly9oZXN0aWFmbG93LmxvdmllLm1lL3YxL2NoYXQvY29tcGxldGlv",
  "bnMgXFxcbiIsICIgICAgICA8ZGl2IGNsYXNzPVwidGVybWJveFwiIHN0eWxlPVwib3ZlcmZsb3c6YXV0b1wiPjxwcmUgaWQ9XCJjdXJsRXhhbXBsZVwiIHN0",
  "eWxlPVwibWFyZ2luOjA7d2hpdGUtc3BhY2U6cHJlO2ZvbnQtc2l6ZToxM3B4XCI+Y3VybCAke2VzYyhTRVRUSU5HUy5iYXNlVXJsIHx8IFwiXCIpfS9jaGF0",
  "L2NvbXBsZXRpb25zIFxcXG4iXSwgWyIgICAgICA8ZGl2IGNsYXNzPVwidGVybWJveFwiIHN0eWxlPVwib3ZlcmZsb3c6YXV0b1wiPjxwcmUgaWQ9XCJjdXJs",
  "SW1hZ2VFeGFtcGxlXCIgc3R5bGU9XCJtYXJnaW46MDt3aGl0ZS1zcGFjZTpwcmU7Zm9udC1zaXplOjEzcHhcIj5jdXJsIGh0dHBzOi8vaGVzdGlhZmxvdy5s",
  "b3ZpZS5tZS92MS9pbWFnZXMvZ2VuZXJhdGlvbnMgXFxcbiIsICIgICAgICA8ZGl2IGNsYXNzPVwidGVybWJveFwiIHN0eWxlPVwib3ZlcmZsb3c6YXV0b1wi",
  "PjxwcmUgaWQ9XCJjdXJsSW1hZ2VFeGFtcGxlXCIgc3R5bGU9XCJtYXJnaW46MDt3aGl0ZS1zcGFjZTpwcmU7Zm9udC1zaXplOjEzcHhcIj5jdXJsICR7ZXNj",
  "KFNFVFRJTkdTLmJhc2VVcmwgfHwgXCJcIil9L2ltYWdlcy9nZW5lcmF0aW9ucyBcXFxuIl1d",
];
const pairs = JSON.parse(Buffer.from(B64.join(''), 'base64').toString('utf8'));
let s = readFileSync('public/app2.js', 'utf8');
for (const [o, n] of pairs) {
  const c = s.split(o).length - 1;
  if (c !== 1) { console.error('BLOK GAGAL, jumlah=', c, JSON.stringify(o.slice(0, 80))); process.exit(1); }
  s = s.replace(o, n);
}
writeFileSync('public/app2.js', s);
console.log('patch OK:', pairs.length, 'blok diterapkan');
