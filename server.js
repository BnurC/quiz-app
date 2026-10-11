const express = require("express");
const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const sorular = require("./questions.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/qr", async (req, res) => {
  const pin = String(req.query.pin || "").replace(/\D/g, "").slice(0, 6);
  const protokol = String(req.headers["x-forwarded-proto"] || req.protocol).split(",")[0];
  const adres = protokol + "://" + req.get("host") + "/?pin=" + pin;
  try {
    const png = await QRCode.toBuffer(adres, { width: 300, margin: 1 });
    res.type("png").send(png);
  } catch (e) {
    res.status(500).end();
  }
});

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

function siraBul(oyun, oyuncu) {
  return oyun.oyuncular.filter((o) => o.puan > oyuncu.puan).length + 1;
}

function siraPaketi(oyun, oyuncu) {
  return {
    sira: siraBul(oyun, oyuncu),
    puan: oyuncu.puan,
    kisi: oyun.oyuncular.length,
  };
}

function soruPaketi(oyun) {
  const s = sorular[oyun.soruNo];
  const gecen = (Date.now() - oyun.baslangic) / 1000;
  return {
    no: oyun.soruNo + 1,
    toplam: sorular.length,
    soru: s.soru,
    secenekler: s.secenekler,
    sure: Math.max(1, Math.ceil(s.sure - gecen)),
  };
}

function cevapSayisiPaketi(oyun) {
  return {
    cevaplayan: oyun.oyuncular.filter((o) => o.cevapladi).length,
    toplam: oyun.oyuncular.length,
  };
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
    o.sonSonuc = null;
    if (oyun.soruNo > 0) {
      io.to(o.id).emit("siraGuncel", siraPaketi(oyun, o));
    }
  });

  io.to(pin).emit("soru", soruPaketi(oyun));
  oyun.zamanlayici = setTimeout(() => soruBitir(pin), s.sure * 1000);
}

function soruBitir(pin) {
  const oyun = oyunlar[pin];
  if (!oyun || oyun.durum !== "soru") return;

  clearTimeout(oyun.zamanlayici);
  oyun.durum = "sonuc";

  const s = sorular[oyun.soruNo];
  const dagilim = s.secenekler.map(() => 0);

  // Puanlar eklenmeden ÖNCE herkesin sırasını hesapla
  const oncekiSiralar = oyun.oyuncular.map((o) => siraBul(oyun, o));
  const kisi = oyun.oyuncular.length;

  oyun.oyuncular.forEach((o, i) => {
    const dogruMu = o.sonSecenek === s.dogru;
    const kazanilan = dogruMu ? o.sonPuan : 0;
    const oncekiPuan = o.puan;
    o.puan += kazanilan;
    if (o.sonSecenek !== null) dagilim[o.sonSecenek]++;
    o.sonSonuc = {
      dogruMu,
      kazanilan,
      toplam: o.puan,
      oncekiPuan,
      oncekiSira: oyun.soruNo > 0 ? oncekiSiralar[i] : null,
      kisi,
    };
    io.to(o.id).emit("sonuc", o.sonSonuc);
  });

  oyun.hostSonuc = {
    dogru: s.dogru,
    dogruMetin: s.secenekler[s.dogru],
    dagilim,
    siralama: siralama(oyun).slice(0, 5),
    sonSoruMu: oyun.soruNo === sorular.length - 1,
  };
  io.to(oyun.host).emit("soruSonucu", oyun.hostSonuc);
}

function hostaDurumGonder(socket, pin, oyun) {
  socket.emit("oyunOlusturuldu", { pin: pin, token: oyun.hostToken });
  socket.emit("oyuncuListesi", oyun.oyuncular.map((o) => o.isim));
  if (oyun.durum === "soru") {
    socket.emit("soru", soruPaketi(oyun));
    socket.emit("cevapSayisi", cevapSayisiPaketi(oyun));
  } else if (oyun.durum === "sonuc") {
    socket.emit("soruSonucu", oyun.hostSonuc);
  } else if (oyun.durum === "bitti") {
    socket.emit("oyunBitti", siralama(oyun));
  }
}

io.on("connection", (socket) => {
  console.log("Biri bağlandı:", socket.id);

  socket.on("oyunOlustur", () => {
    const pin = pinUret();
    oyunlar[pin] = {
      host: socket.id,
      hostToken: randomUUID(),
      oyuncular: [],
      durum: "lobi",
      soruNo: -1,
      baslangic: 0,
      zamanlayici: null,
      hostSonuc: null,
      olusturma: Date.now(),
    };
    socket.join(pin);
    hostaDurumGonder(socket, pin, oyunlar[pin]);
  });

  socket.on("hostDon", (veri) => {
    const pin = String((veri && veri.pin) || "");
    const oyun = oyunlar[pin];
    if (!oyun || oyun.hostToken !== String(veri.token)) {
      socket.emit("oturumYok");
      return;
    }
    oyun.host = socket.id;
    socket.join(pin);
    hostaDurumGonder(socket, pin, oyun);
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

    const token = randomUUID();
    oyun.oyuncular.push({
      id: socket.id,
      token: token,
      isim: isim,
      puan: 0,
      cevapladi: false,
      sonSecenek: null,
      sonPuan: 0,
      sonSonuc: null,
    });
    socket.join(pin);
    socket.emit("katildin", { pin: pin, isim: isim, token: token });
    io.to(oyun.host).emit("oyuncuListesi", oyun.oyuncular.map((o) => o.isim));
  });

  socket.on("tekrarKatil", (veri) => {
    const pin = String((veri && veri.pin) || "");
    const oyun = oyunlar[pin];
    const oyuncu = oyun && oyun.oyuncular.find((o) => o.token === String(veri.token));
    if (!oyuncu) {
      socket.emit("oturumYok");
      return;
    }

    oyuncu.id = socket.id;
    socket.join(pin);
    socket.emit("katildin", { pin: pin, isim: oyuncu.isim, token: oyuncu.token });

    if (oyun.durum === "soru") {
      if (oyun.soruNo > 0) socket.emit("siraGuncel", siraPaketi(oyun, oyuncu));
      if (oyuncu.cevapladi) socket.emit("cevapAlindi");
      else socket.emit("soru", soruPaketi(oyun));
    } else if (oyun.durum === "sonuc" && oyuncu.sonSonuc) {
      socket.emit("sonuc", oyuncu.sonSonuc);
    } else if (oyun.durum === "bitti") {
      socket.emit("oyunBitti", siralama(oyun));
    }
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

    const paket = cevapSayisiPaketi(oyun);
    io.to(oyun.host).emit("cevapSayisi", paket);

    if (paket.cevaplayan === paket.toplam) soruBitir(pin);
  });

  socket.on("sonrakiSoru", (pin) => {
    const oyun = oyunlar[String(pin)];
    if (!oyun || oyun.host !== socket.id || oyun.durum !== "sonuc") return;
    sonrakiSoru(String(pin));
  });

  socket.on("oyunuBitir", (pin) => {
    pin = String(pin);
    const oyun = oyunlar[pin];
    if (!oyun || oyun.host !== socket.id) return;
    if (oyun.durum !== "soru" && oyun.durum !== "sonuc") return;

    clearTimeout(oyun.zamanlayici);
    oyun.durum = "bitti";
    io.to(pin).emit("oyunBitti", siralama(oyun));
  });

  socket.on("cik", () => {
    for (const pin in oyunlar) {
      const oyun = oyunlar[pin];
      const i = oyun.oyuncular.findIndex((o) => o.id === socket.id);
      if (i === -1) continue;

      oyun.oyuncular.splice(i, 1);
      socket.leave(pin);
      socket.emit("ciktin");
      io.to(oyun.host).emit("oyuncuListesi", oyun.oyuncular.map((o) => o.isim));

      if (oyun.durum === "soru") {
        const paket = cevapSayisiPaketi(oyun);
        io.to(oyun.host).emit("cevapSayisi", paket);
        if (paket.toplam > 0 && paket.cevaplayan === paket.toplam) soruBitir(pin);
      }
      return;
    }
  });

  socket.on("disconnect", () => {
    console.log("Biri ayrıldı:", socket.id);
  });
});

// 6 saatten eski oyunları hafızadan temizle
setInterval(() => {
  const simdi = Date.now();
  for (const pin in oyunlar) {
    if (simdi - oyunlar[pin].olusturma > 6 * 60 * 60 * 1000) {
      clearTimeout(oyunlar[pin].zamanlayici);
      delete oyunlar[pin];
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Sunucu " + PORT + " portunda çalışıyor");
});