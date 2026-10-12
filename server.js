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

function ustFark(oyun, oyuncu) {
  let en = null;
  oyun.oyuncular.forEach((o) => {
    if (o.puan > oyuncu.puan && (en === null || o.puan < en.puan)) en = o;
  });
  return en ? { isim: en.isim, fark: en.puan - oyuncu.puan } : null;
}

function siraPaketi(oyun, oyuncu) {
  return {
    sira: siraBul(oyun, oyuncu),
    puan: oyuncu.puan,
    kisi: oyun.oyuncular.length,
    ust: ustFark(oyun, oyuncu),
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

// Şıklar açılmadan önceki aşama: şık ve doğru cevap GÖNDERİLMEZ
function okumaPaketi(oyun) {
  const s = sorular[oyun.soruNo];
  return {
    no: oyun.soruNo + 1,
    toplam: sorular.length,
    soru: s.soru,
    sure: s.sure,
  };
}

function cevapSayisiPaketi(oyun) {
  return {
    cevaplayan: oyun.oyuncular.filter((o) => o.cevapladi).length,
    toplam: oyun.oyuncular.length,
  };
}

function soruyuBaslat(pin) {
  const oyun = oyunlar[pin];
  if (!oyun) return;

  const s = sorular[oyun.soruNo];
  oyun.durum = "soru";
  oyun.baslangic = Date.now();

  io.to(pin).emit("soru", soruPaketi(oyun));
  oyun.zamanlayici = setTimeout(() => soruBitir(pin), s.sure * 1000);
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

  oyun.oyuncular.forEach((o) => {
    o.cevapladi = false;
    o.sonSecenek = null;
    o.sonSonuc = null;
    if (oyun.soruNo > 0) {
      io.to(o.id).emit("siraGuncel", siraPaketi(oyun, o));
    }
  });

  if (oyun.manuel) {
    oyun.durum = "okuma";
    io.to(pin).emit("okuma", okumaPaketi(oyun));
  } else {
    soruyuBaslat(pin);
  }
}

function soruBitir(pin) {
  const oyun = oyunlar[pin];
  if (!oyun || oyun.durum !== "soru") return;

  clearTimeout(oyun.zamanlayici);
  oyun.durum = "sonuc";

  const s = sorular[oyun.soruNo];
  const dagilim = s.secenekler.map(() => 0);

  // 1. tur: herkesin puanını güncelle
  oyun.oyuncular.forEach((o) => {
    const dogruMu = o.sonSecenek === s.dogru;
    o.sonDogru = dogruMu;
    o.sonKazanilan = dogruMu ? o.sonPuan : 0;
    o.puan += o.sonKazanilan;
    if (o.sonSecenek !== null) dagilim[o.sonSecenek]++;
  });

  // 2. tur: puanlar güncellendikten SONRA sıra ve ilk 5'i hesapla, herkese gönder
  const top5 = siralama(oyun).slice(0, 5);

  oyun.oyuncular.forEach((o) => {
    o.sonSonuc = {
      dogruMu: o.sonDogru,
      kazanilan: o.sonKazanilan,
      guncel: siraPaketi(oyun, o),
      top5: top5,
    };
    io.to(o.id).emit("sonuc", o.sonSonuc);
  });

  oyun.hostSonuc = {
    dogru: s.dogru,
    dogruMetin: s.secenekler[s.dogru],
    dagilim,
    siralama: top5,
    sonSoruMu: oyun.soruNo === sorular.length - 1,
  };
  io.to(oyun.host).emit("soruSonucu", oyun.hostSonuc);
}

function hostaDurumGonder(socket, pin, oyun) {
  socket.emit("oyunOlusturuldu", { pin: pin, token: oyun.hostToken });
  socket.emit("oyuncuListesi", oyun.oyuncular.map((o) => o.isim));
  if (oyun.durum === "okuma") {
    socket.emit("okuma", okumaPaketi(oyun));
  } else if (oyun.durum === "soru") {
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
      manuel: false,
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

    if (oyun.durum === "okuma") {
      if (oyun.soruNo > 0) socket.emit("siraGuncel", siraPaketi(oyun, oyuncu));
      socket.emit("okuma", okumaPaketi(oyun));
    } else if (oyun.durum === "soru") {
      if (oyun.soruNo > 0) socket.emit("siraGuncel", siraPaketi(oyun, oyuncu));
      if (oyuncu.cevapladi) socket.emit("cevapAlindi");
      else socket.emit("soru", soruPaketi(oyun));
    } else if (oyun.durum === "sonuc" && oyuncu.sonSonuc) {
      socket.emit("sonuc", oyuncu.sonSonuc);
    } else if (oyun.durum === "bitti") {
      socket.emit("oyunBitti", siralama(oyun));
    }
  });

  // Hem eski biçimi (sadece PIN) hem yeni biçimi ({ pin, manuel }) kabul eder
  socket.on("oyunBaslat", (veri) => {
    const nesne = veri !== null && typeof veri === "object";
    const pin = String(nesne ? veri.pin : veri);
    const oyun = oyunlar[pin];
    if (!oyun || oyun.host !== socket.id || oyun.durum !== "lobi") return;
    if (oyun.oyuncular.length === 0) return;
    oyun.manuel = nesne && veri.manuel === true;
    sonrakiSoru(pin);
  });

  socket.on("siklariAc", (pin) => {
    pin = String(pin);
    const oyun = oyunlar[pin];
    if (!oyun || oyun.host !== socket.id || oyun.durum !== "okuma") return;
    soruyuBaslat(pin);
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
    if (oyun.durum !== "okuma" && oyun.durum !== "soru" && oyun.durum !== "sonuc") return;

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