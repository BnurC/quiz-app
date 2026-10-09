const oyunlar = {};

function pinUret() {
    let pin;
    do {
        pin = String(Math.floor(100000 + Math.random() * 900000));
    } while (oyunlar[pin]);
    return pin;
}

 oyunlar["123456"] = {host: "abc", oyuncular: [] };
 oyunlar["123456"].oyuncular.push({isim: "Ali", puan: 0});

 console.log(oyunlar["123456"].oyuncular[0].isim);

 oyunlar["654321"] = {host: "asd", oyuncular: []};
 oyunlar["654321"].oyuncular.push({isim: "buse", puan: 0});

 console.log(oyunlar["654321"].oyuncular[0].isim);

 console.log(pinUret());
 console.log(pinUret());
 console.log(pinUret());