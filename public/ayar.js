const AYAR = {
  baslik: "Quiz",
  altBaslik: "Hazır mısın?",
  logo: "", // örn: "/logo.png" (logo dosyasını public klasörüne koy)
};

function baslikKur() {
  document.title = AYAR.baslik;
  const b = document.getElementById("baslik");
  if (b) b.textContent = AYAR.baslik;
  const a = document.getElementById("altBaslik");
  if (a) a.textContent = AYAR.altBaslik;
  const l = document.getElementById("logo");
  if (l) {
    if (AYAR.logo) {
      l.src = AYAR.logo;
      l.style.display = "inline-block";
    } else {
      l.style.display = "none";
    }
  }
}