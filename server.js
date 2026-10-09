const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sorular = require("./questions.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const path = require("path");

app.use(express.static(path.join(__dirname, "public")));

const oyunlar = {};

function pinUret() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (oyunlar[pin]);
  return pin;
}

function siralama(oyun) {
  return [...oyun.oyuncular]
    .sort((a, b) => b.puan - a.puan)
    .map((o) => ({ isim: o.isim, puan: o.puan }));
}

function sonrakiSoru(pin) {
  const oyun = oyunlar[pin];
  if (!oyun) return;

  oyun.soruNo++;

  if (oyun.soruNo >= sorular.length) {
    oyun.durum = "bitti";
    io.to(pin).emit("oyunBitti", siralama(oyun));
    return;
  }

  const s = sorular[oyun.soruNo];
  oyun.durum = "soru";
  oyun.baslangic = Date.now();
  oyun.oyuncular.forEach((o) => {
    o.cevapladi = false;
    o.sonSecenek = null;
  });

  io.to(pin).emit("soru", {
    no: oyun.soruNo + 1,
    toplam: sorular.length,
    soru: s.soru,
    secenekler: s.secenekler,
    sure: s.sure,
  });

  oyun.zamanlayici = setTimeout(() => soruBitir(pin), s.sure * 1000);
}

function soruBitir(pin) {
  const oyun = oyunlar[pin];
  if (!oyun || oyun.durum !== "soru") return;

  clearTimeout(oyun.zamanlayici);
  oyun.durum = "sonuc";

  const s = sorular[oyun.soruNo];
  const dagilim = s.secenekler.map(() => 0);

  oyun.oyuncular.forEach((o) => {
    const dogruMu = o.sonSecenek === s.dogru;
    const kazanilan = dogruMu ? o.sonPuan : 0;
    o.puan += kazanilan;
    if (o.sonSecenek !== null) dagilim[o.sonSecenek]++;
    io.to(o.id).emit("sonuc", { dogruMu, kazanilan, toplam: o.puan });
  });

  io.to(oyun.host).emit("soruSonucu", {
    dogru: s.dogru,
    dogruMetin: s.secenekler[s.dogru],
    dagilim,
    siralama: siralama(oyun).slice(0, 5),
    sonSoruMu: oyun.soruNo === sorular.length - 1,
  });
}

io.on("connection", (socket) => {
  console.log("Biri bağlandı:", socket.id);

  socket.on("oyunOlustur", () => {
    const pin = pinUret();
    oyunlar[pin] = {
      host: socket.id,
      oyuncular: [],
      durum: "lobi",
      soruNo: -1,
      baslangic: 0,
      zamanlayici: null,
    };
    socket.join(pin);
    socket.emit("oyunOlusturuldu", pin);
  });

  socket.on("katil", (veri) => {
    const pin = String(veri.pin).trim();
    const isim = String(veri.isim).trim();
    const oyun = oyunlar[pin];

    if (!oyun) {
      socket.emit("hata", "Bu PIN ile bir oyun bulunamadı.");
      return;
    }
    if (oyun.durum !== "lobi") {
      socket.emit("hata", "Oyun zaten başladı.");
      return;
    }
    if (isim === "" || isim.length > 20) {
      socket.emit("hata", "İsim 1-20 karakter arasında olmalı.");
      return;
    }
    if (oyun.oyuncular.some((o) => o.isim === isim)) {
      socket.emit("hata", "Bu isim zaten alınmış.");
      return;
    }

    oyun.oyuncular.push({
      id: socket.id,
      isim: isim,
      puan: 0,
      cevapladi: false,
      sonSecenek: null,
      sonPuan: 0,
    });
    socket.join(pin);
    socket.emit("katildin", { pin: pin, isim: isim });
    io.to(oyun.host).emit("oyuncuListesi", oyun.oyuncular.map((o) => o.isim));
  });

  socket.on("oyunBaslat", (pin) => {
    const oyun = oyunlar[String(pin)];
    if (!oyun || oyun.host !== socket.id || oyun.durum !== "lobi") return;
    if (oyun.oyuncular.length === 0) return;
    sonrakiSoru(String(pin));
  });

  socket.on("cevap", (veri) => {
    const pin = String(veri.pin);
    const oyun = oyunlar[pin];
    if (!oyun || oyun.durum !== "soru") return;

    const oyuncu = oyun.oyuncular.find((o) => o.id === socket.id);
    if (!oyuncu || oyuncu.cevapladi) return;

    const s = sorular[oyun.soruNo];
    const secenek = Number(veri.secenek);
    if (!Number.isInteger(secenek) || secenek < 0 || secenek >= s.secenekler.length) return;

    const gecen = Date.now() - oyun.baslangic;
    const oran = Math.min(gecen / (s.sure * 1000), 1);

    oyuncu.cevapladi = true;
    oyuncu.sonSecenek = secenek;
    oyuncu.sonPuan = Math.round(1000 * (1 - oran / 2));

    socket.emit("cevapAlindi");

    const cevaplayan = oyun.oyuncular.filter((o) => o.cevapladi).length;
    io.to(oyun.host).emit("cevapSayisi", {
      cevaplayan,
      toplam: oyun.oyuncular.length,
    });

    if (cevaplayan === oyun.oyuncular.length) soruBitir(pin);
  });

  socket.on("sonrakiSoru", (pin) => {
    const oyun = oyunlar[String(pin)];
    if (!oyun || oyun.host !== socket.id || oyun.durum !== "sonuc") return;
    sonrakiSoru(String(pin));
  });

  socket.on("disconnect", () => {
    console.log("Biri ayrıldı:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Sunucu " + PORT + " portunda çalışıyor");
});