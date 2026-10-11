const { io } = require("socket.io-client");

const URL = process.argv[2] || "http://localhost:3000";
const N = Number(process.argv[3] || 30);

let pin = null;
let katilan = 0;
const host = io(URL);

host.on("connect", () => {
  if (!pin) host.emit("oyunOlustur");
});

host.on("oyunOlusturuldu", (v) => {
  if (pin) return;
  pin = v.pin;
  console.log("PIN:", pin, "| bot sayisi:", N);
  for (let i = 0; i < N; i++) botEkle(i);
  setTimeout(() => {
    console.log("Katilan bot:", katilan, "/", N);
    host.emit("oyunBaslat", pin);
  }, 4000);
});

host.on("soruSonucu", (v) => {
  const cevaplayan = v.dagilim.reduce((a, b) => a + b, 0);
  console.log("Soru bitti, cevaplayan:", cevaplayan, "/", N);
  setTimeout(() => host.emit("sonrakiSoru", pin), 1000);
});

host.on("oyunBitti", (siralama) => {
  console.log("OYUN BITTI. Skor tablosundaki oyuncu:", siralama.length, "/", N);
  console.log(siralama.length === N ? "TEST BASARILI" : "TEST BASARISIZ");
  process.exit(siralama.length === N ? 0 : 1);
});

function botEkle(i) {
  const s = io(URL);
  const isim = "Bot" + i;
  s.on("connect", () => s.emit("katil", { pin, isim }));
  s.on("hata", (m) => console.log(isim, "HATA:", m));
  s.on("katildin", () => katilan++);
  s.on("soru", (q) => {
    setTimeout(() => {
      s.emit("cevap", { pin, secenek: Math.floor(Math.random() * q.secenekler.length) });
    }, Math.random() * 4000);
  });
}

setTimeout(() => {
  console.log("ZAMAN ASIMI: oyun 3 dakikada bitmedi");
  process.exit(1);
}, 180000);