/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.0 — CETAK STRUK HIBRIDA (ANDROID + iOS)
 * File: js/receipt.js
 * ============================================================================
 * - Android / Desktop: Web Bluetooth ESC/POS 58mm, RawBT Intent, Print/PDF, WA
 * - iOS (iPhone/iPad): Render Struk PNG lebar 384px -> navigator.share({ files })
 *   untuk aplikasi printer thermal iOS (Thermer / Print Label) atau WhatsApp,
 *   ditambah Print/PDF & Share Teks WA.
 */

window.POS_RECEIPT = (function () {
  "use strict";

  let currentReceipt = null;
  let cachedBtDevice = null;
  let cachedBtCharacteristic = null;

  // Daftar UUID GATT Service standar printer thermal Bluetooth 58mm (RPP02N, Eppos, Panda, VSC, dll.)
  const BT_SERVICE_UUIDS = [
    "000018f0-0000-1000-8000-00805f9b34fb",
    "0000ff00-0000-1000-8000-00805f9b34fb",
    "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
    "49535343-fe7d-4ae5-8fa9-9fafd205e455"
  ];

  // ==========================================================================
  // UTILITAS FORMAT & DETEKSI OS
  // ==========================================================================

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatRp(n) {
    return "Rp " + Math.round(Number(n) || 0).toLocaleString("id-ID");
  }

  function isIosPlatform() {
    if (window.POS_AUTH && typeof window.POS_AUTH.isIosDevice === "function") {
      return window.POS_AUTH.isIosDevice();
    }
    const ua = navigator.userAgent || "";
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function applyOsActionButtons() {
    const isIos = isIosPlatform();
    const badgeEl = document.getElementById("struk-os-badge");
    const androidBox = document.getElementById("struk-actions-android");
    const iosBox = document.getElementById("struk-actions-ios");

    if (androidBox) androidBox.style.display = isIos ? "none" : "flex";
    if (iosBox) iosBox.style.display = isIos ? "flex" : "none";

    if (badgeEl) {
      badgeEl.textContent = isIos
        ? "Mode iOS Terdeteksi (Share/Cetak PNG 58mm)"
        : "Mode Android / Desktop (Bluetooth ESC/POS & RawBT)";
    }
  }

  // ==========================================================================
  // 1. RENDER TAMPILAN STRUK 58MM KE #tampilan-struk
  // ==========================================================================

  function normalizeReceiptData(raw) {
    const cfg =
      (raw && raw.pengaturan) ||
      (window.POS_RETAIL ? window.POS_RETAIL.getReceiptStoreConfig() : {}) ||
      {};

    const items = Array.isArray(raw && raw.items)
      ? raw.items
      : Array.isArray(raw && raw.keranjang)
      ? raw.keranjang
      : [];

    const subtotal =
      raw && raw.subtotal !== undefined
        ? Number(raw.subtotal)
        : items.reduce((acc, it) => acc + (Number(it.subtotal) || Number(it.qty) * Number(it.harga)), 0);

    const diskonTotal = Math.max(0, Number(raw && raw.diskonTotal) || 0);
    const totalBelanja =
      raw && raw.totalBelanja !== undefined ? Number(raw.totalBelanja) : Math.max(0, subtotal - diskonTotal);
    const bayar = Number(raw && raw.bayar) || 0;
    const status = String((raw && raw.status) || "Lunas");
    const kembalian = status === "Hutang" ? 0 : Math.max(0, bayar - totalBelanja);
    const sisaHutang = status === "Hutang" ? Math.max(0, totalBelanja - bayar) : 0;

    return {
      idTrx: String((raw && raw.idTrx) || "-"),
      tanggal: String((raw && raw.tanggal) || ""),
      waktu: String((raw && raw.waktu) || ""),
      kasir: String((raw && raw.kasir) || "Kasir"),
      pelanggan: String((raw && raw.pelanggan) || "Umum"),
      noWa: String((raw && raw.noWa) || ""),
      metode: String((raw && raw.metode) || "Tunai"),
      status,
      tipeTrx: String((raw && raw.tipeTrx) || "RITEL"),
      items,
      subtotal,
      diskonTotal,
      totalBelanja,
      bayar,
      kembalian,
      sisaHutang,
      pengaturan: {
        namaToko: cfg.namaToko || "AL-KAUTSAR FILTER AIR",
        alamatToko: cfg.alamatToko || "Lampung, Indonesia",
        telpToko: cfg.telpToko || "",
        footerStruk: cfg.footerStruk || "Terima kasih atas kepercayaan Anda."
      }
    };
  }

  function renderReceipt(rawTrx) {
    currentReceipt = normalizeReceiptData(rawTrx);
    applyOsActionButtons();

    const container = document.getElementById("tampilan-struk");
    if (!container) return;

    const r = currentReceipt;
    const itemsHtml = r.items
      .map((it) => {
        const qty = Number(it.qty) || 0;
        const harga = Number(it.harga) || 0;
        const sub = Number(it.subtotal) || qty * harga;
        return `
          <div style="margin-bottom:5px;">
            <div style="font-weight:bold;">${escapeHtml(it.nama)}</div>
            <div style="display:flex; justify-content:space-between;">
              <span>${qty} x ${formatRp(harga)}</span>
              <span>${formatRp(sub)}</span>
            </div>
          </div>
        `;
      })
      .join("");

    const diskonRow =
      r.diskonTotal > 0
        ? `
          <div style="display:flex; justify-content:space-between;">
            <span>Subtotal</span>
            <span>${formatRp(r.subtotal)}</span>
          </div>
          <div style="display:flex; justify-content:space-between;">
            <span>Diskon</span>
            <span>-${formatRp(r.diskonTotal)}</span>
          </div>
        `
        : "";

    const statusLine =
      r.status === "Hutang"
        ? `
          <div style="display:flex; justify-content:space-between;">
            <span>DP / Bayar</span>
            <span>${formatRp(r.bayar)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-weight:bold;">
            <span>SISA HUTANG</span>
            <span>${formatRp(r.sisaHutang)}</span>
          </div>
        `
        : `
          <div style="display:flex; justify-content:space-between;">
            <span>Bayar (${escapeHtml(r.metode)})</span>
            <span>${formatRp(r.bayar)}</span>
          </div>
          <div style="display:flex; justify-content:space-between;">
            <span>Kembalian</span>
            <span>${formatRp(r.kembalian)}</span>
          </div>
        `;

    container.innerHTML = `
      <div style="text-align:center; margin-bottom:6px;">
        <div style="font-size:14px; font-weight:bold; letter-spacing:0.3px;">${escapeHtml(r.pengaturan.namaToko)}</div>
        <div style="font-size:11px;">${escapeHtml(r.pengaturan.alamatToko)}</div>
        ${r.pengaturan.telpToko ? `<div style="font-size:11px;">WA/Telp: ${escapeHtml(r.pengaturan.telpToko)}</div>` : ""}
      </div>
      <div style="border-top:1px dashed #000; margin:6px 0;"></div>
      <div style="font-size:11px; line-height:1.45;">
        <div>No   : ${escapeHtml(r.idTrx)}</div>
        <div>Tgl  : ${escapeHtml(r.tanggal)} ${escapeHtml(r.waktu)}</div>
        <div>Kasir: ${escapeHtml(r.kasir)}</div>
        <div>Plg  : ${escapeHtml(r.pelanggan)}</div>
        <div>Sts  : ${escapeHtml(r.status.toUpperCase())}${r.tipeTrx === "NGAMPAS" ? " (NGAMPAS)" : ""}</div>
      </div>
      <div style="border-top:1px dashed #000; margin:6px 0;"></div>
      <div style="font-size:11px;">
        ${itemsHtml || "<div>(Rincian item tidak tersedia)</div>"}
      </div>
      <div style="border-top:1px dashed #000; margin:6px 0;"></div>
      <div style="font-size:12px; line-height:1.5;">
        ${diskonRow}
        <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:13px;">
          <span>TOTAL</span>
          <span>${formatRp(r.totalBelanja)}</span>
        </div>
        ${statusLine}
      </div>
      <div style="border-top:1px dashed #000; margin:8px 0;"></div>
      <div style="text-align:center; font-size:11px;">
        ${escapeHtml(r.pengaturan.footerStruk)}
      </div>
    `;
  }

  function openReceipt(rawTrx) {
    renderReceipt(rawTrx);
    if (window.POS_AUTH && typeof window.POS_AUTH.navigateTo === "function") {
      window.POS_AUTH.navigateTo("page-struk");
    }
  }

  // ==========================================================================
  // 2. GENERATOR TEKS & ESC/POS 58MM (32 KARAKTER PER BARIS)
  // ==========================================================================

  function padLine32(left, right) {
    const maxLen = 32;
    const l = String(left || "");
    const r = String(right || "");
    const spaces = maxLen - l.length - r.length;
    if (spaces >= 1) return l + " ".repeat(spaces) + r;
    const cutLeft = l.slice(0, Math.max(1, maxLen - r.length - 1));
    return cutLeft + " " + r;
  }

  function wrapCenter32(text) {
    const clean = String(text || "").trim();
    if (!clean) return [];
    const words = clean.split(/\s+/);
    const lines = [];
    let curr = "";
    words.forEach((w) => {
      if ((curr + " " + w).trim().length <= 32) {
        curr = (curr + " " + w).trim();
      } else {
        if (curr) lines.push(curr);
        curr = w.slice(0, 32);
      }
    });
    if (curr) lines.push(curr);
    return lines;
  }

  function buildEscPosBytes(r) {
    const encoder = new TextEncoder();
    const chunks = [];
    const pushBytes = (arr) => chunks.push(new Uint8Array(arr));
    const pushText = (txt) => chunks.push(encoder.encode(txt));

    const DASH = "--------------------------------\n";

    // Init Printer
    pushBytes([0x1b, 0x40]);

    // Header Center + Bold
    pushBytes([0x1b, 0x61, 0x01]); // Center
    pushBytes([0x1b, 0x45, 0x01]); // Bold ON
    wrapCenter32(r.pengaturan.namaToko).forEach((ln) => pushText(ln + "\n"));
    pushBytes([0x1b, 0x45, 0x00]); // Bold OFF
    wrapCenter32(r.pengaturan.alamatToko).forEach((ln) => pushText(ln + "\n"));
    if (r.pengaturan.telpToko) {
      pushText("WA: " + r.pengaturan.telpToko + "\n");
    }

    // Info Transaksi (Left)
    pushBytes([0x1b, 0x61, 0x00]); // Left
    pushText(DASH);
    pushText(`No   : ${r.idTrx}\n`);
    pushText(`Tgl  : ${r.tanggal} ${r.waktu}\n`);
    pushText(`Kasir: ${r.kasir}\n`);
    pushText(`Plg  : ${r.pelanggan}\n`);
    pushText(`Sts  : ${r.status.toUpperCase()}\n`);
    pushText(DASH);

    // Item
    r.items.forEach((it) => {
      const qty = Number(it.qty) || 0;
      const harga = Number(it.harga) || 0;
      const sub = Number(it.subtotal) || qty * harga;
      pushText(String(it.nama || "").slice(0, 32) + "\n");
      pushText(padLine32(`${qty}x ${harga.toLocaleString("id-ID")}`, sub.toLocaleString("id-ID")) + "\n");
    });

    pushText(DASH);

    if (r.diskonTotal > 0) {
      pushText(padLine32("Subtotal", formatRp(r.subtotal)) + "\n");
      pushText(padLine32("Diskon", "-" + formatRp(r.diskonTotal)) + "\n");
    }

    pushBytes([0x1b, 0x45, 0x01]); // Bold ON
    pushText(padLine32("TOTAL", formatRp(r.totalBelanja)) + "\n");
    pushBytes([0x1b, 0x45, 0x00]); // Bold OFF

    if (r.status === "Hutang") {
      pushText(padLine32("DP/Bayar", formatRp(r.bayar)) + "\n");
      pushText(padLine32("SISA HUTANG", formatRp(r.sisaHutang)) + "\n");
    } else {
      pushText(padLine32(`Bayar (${r.metode})`, formatRp(r.bayar)) + "\n");
      pushText(padLine32("Kembalian", formatRp(r.kembalian)) + "\n");
    }

    pushText(DASH);

    // Footer Center
    pushBytes([0x1b, 0x61, 0x01]);
    wrapCenter32(r.pengaturan.footerStruk).forEach((ln) => pushText(ln + "\n"));
    pushText("\n\n\n");

    // Gabungkan semua Uint8Array
    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    chunks.forEach((c) => {
      merged.set(c, offset);
      offset += c.length;
    });
    return merged;
  }

  // ==========================================================================
  // 3. CETAK ANDROID: WEB BLUETOOTH ESC/POS 58MM & RAWBT
  // ==========================================================================

  async function findWritableCharacteristic(server) {
    for (let i = 0; i < BT_SERVICE_UUIDS.length; i++) {
      try {
        const service = await server.getPrimaryService(BT_SERVICE_UUIDS[i]);
        const chars = await service.getCharacteristics();
        for (let c = 0; c < chars.length; c++) {
          if (chars[c].properties.write || chars[c].properties.writeWithoutResponse) {
            return chars[c];
          }
        }
      } catch (e) {
        // Lanjut coba UUID service berikutnya
      }
    }
    return null;
  }

  async function printBluetoothEscPos() {
    if (!currentReceipt) {
      window.POS_AUTH.showToast("Belum ada data struk untuk dicetak.", "error");
      return;
    }

    if (!navigator.bluetooth) {
      window.POS_AUTH.showToast(
        "Browser ini tidak mendukung Web Bluetooth. Gunakan RawBT atau Cetak PDF.",
        "error"
      );
      return;
    }

    try {
      let charTarget = cachedBtCharacteristic;

      if (!cachedBtDevice || !cachedBtDevice.gatt || !cachedBtDevice.gatt.connected || !charTarget) {
        window.POS_AUTH.showToast("Memilih printer Bluetooth 58mm...", "info");
        cachedBtDevice = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: BT_SERVICE_UUIDS
        });

        const server = await cachedBtDevice.gatt.connect();
        charTarget = await findWritableCharacteristic(server);
        if (!charTarget) {
          throw new Error("Printer terhubung, tetapi karakteristik cetak ESC/POS tidak ditemukan.");
        }
        cachedBtCharacteristic = charTarget;
      }

      const bytes = buildEscPosBytes(currentReceipt);
      const CHUNK_SIZE = 100;

      for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const slice = bytes.slice(i, i + CHUNK_SIZE);
        if (charTarget.properties.writeWithoutResponse) {
          await charTarget.writeValueWithoutResponse(slice);
        } else {
          await charTarget.writeValue(slice);
        }
        await new Promise((resolve) => setTimeout(resolve, 35));
      }

      window.POS_AUTH.showToast("Struk berhasil dikirim ke printer Bluetooth!", "success");
    } catch (err) {
      cachedBtCharacteristic = null;
      if (err && err.name === "NotFoundError") return; // User batal memilih perangkat
      window.POS_AUTH.showToast(
        "Cetak Bluetooth gagal: " + (err.message || "Periksa koneksi printer."),
        "error"
      );
    }
  }

  function printRawBT() {
    if (!currentReceipt) {
      window.POS_AUTH.showToast("Belum ada data struk untuk dicetak.", "error");
      return;
    }

    const bytes = buildEscPosBytes(currentReceipt);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    window.location.href = `intent:base64,${base64}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`;
  }

  // ==========================================================================
  // 4. CETAK / SHARE iOS: RENDER STRUK PNG LEBAR 384PX (THERMAL 58MM)
  // ==========================================================================

  function renderFallbackCanvas384(r) {
    const lines = [
      { text: r.pengaturan.namaToko, bold: true, align: "center" },
      { text: r.pengaturan.alamatToko, align: "center" }
    ];
    if (r.pengaturan.telpToko) {
      lines.push({ text: "WA: " + r.pengaturan.telpToko, align: "center" });
    }
    lines.push({ text: "--------------------------------" });
    lines.push({ text: `No   : ${r.idTrx}` });
    lines.push({ text: `Tgl  : ${r.tanggal} ${r.waktu}` });
    lines.push({ text: `Kasir: ${r.kasir}` });
    lines.push({ text: `Plg  : ${r.pelanggan}` });
    lines.push({ text: `Sts  : ${r.status.toUpperCase()}` });
    lines.push({ text: "--------------------------------" });

    r.items.forEach((it) => {
      const qty = Number(it.qty) || 0;
      const harga = Number(it.harga) || 0;
      const sub = Number(it.subtotal) || qty * harga;
      lines.push({ text: String(it.nama || "").slice(0, 32), bold: true });
      lines.push({
        text: padLine32(`${qty}x ${harga.toLocaleString("id-ID")}`, sub.toLocaleString("id-ID"))
      });
    });

    lines.push({ text: "--------------------------------" });
    if (r.diskonTotal > 0) {
      lines.push({ text: padLine32("Subtotal", formatRp(r.subtotal)) });
      lines.push({ text: padLine32("Diskon", "-" + formatRp(r.diskonTotal)) });
    }
    lines.push({ text: padLine32("TOTAL", formatRp(r.totalBelanja)), bold: true });
    if (r.status === "Hutang") {
      lines.push({ text: padLine32("DP/Bayar", formatRp(r.bayar)) });
      lines.push({ text: padLine32("SISA HUTANG", formatRp(r.sisaHutang)), bold: true });
    } else {
      lines.push({ text: padLine32(`Bayar (${r.metode})`, formatRp(r.bayar)) });
      lines.push({ text: padLine32("Kembalian", formatRp(r.kembalian)) });
    }
    lines.push({ text: "--------------------------------" });
    wrapCenter32(r.pengaturan.footerStruk).forEach((ln) => lines.push({ text: ln, align: "center" }));

    const width = 384;
    const lineHeight = 24;
    const paddingY = 20;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = paddingY * 2 + lines.length * lineHeight;

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    ctx.textBaseline = "top";

    lines.forEach((ln, idx) => {
      ctx.font = `${ln.bold ? "bold " : ""}17px "Courier New", monospace`;
      const y = paddingY + idx * lineHeight;
      if (ln.align === "center") {
        ctx.textAlign = "center";
        ctx.fillText(ln.text, width / 2, y);
      } else {
        ctx.textAlign = "left";
        ctx.fillText(ln.text, 16, y);
      }
    });

    return canvas;
  }

  async function buildThermalPngBlob384() {
    const sourceEl = document.getElementById("tampilan-struk");
    let canvas;

    if (sourceEl && typeof window.html2canvas === "function") {
      // Kloning ke kontainer offscreen lebar tepat 384px agar rasio thermal 58mm tajam & seragam
      const wrapper = document.createElement("div");
      wrapper.style.position = "fixed";
      wrapper.style.left = "-9999px";
      wrapper.style.top = "0";
      wrapper.style.width = "384px";
      wrapper.style.background = "#ffffff";
      wrapper.style.padding = "14px 16px";
      wrapper.style.color = "#000000";
      wrapper.style.fontFamily = "'Courier New', Courier, monospace";
      wrapper.style.fontSize = "15px";
      wrapper.style.lineHeight = "1.45";
      wrapper.innerHTML = sourceEl.innerHTML;
      document.body.appendChild(wrapper);

      try {
        canvas = await window.html2canvas(wrapper, {
          width: 384,
          scale: 1,
          backgroundColor: "#ffffff",
          logging: false,
          useCORS: true
        });
      } finally {
        document.body.removeChild(wrapper);
      }
    } else {
      canvas = renderFallbackCanvas384(currentReceipt);
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Gagal mengonversi struk menjadi gambar PNG."));
      }, "image/png");
    });
  }

  async function shareOrPrintIosPng() {
    if (!currentReceipt) {
      window.POS_AUTH.showToast("Belum ada data struk untuk dibagikan.", "error");
      return;
    }

    const btn = document.getElementById("btn-ios-share-png");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyiapkan Gambar 58mm...';
    }

    try {
      const pngBlob = await buildThermalPngBlob384();
      const safeId = currentReceipt.idTrx.replace(/[^a-zA-Z0-9_-]/g, "");
      const fileName = `Struk-${safeId || "AlKautsar"}.png`;
      const pngFile = new File([pngBlob], fileName, { type: "image/png" });

      if (navigator.canShare && navigator.canShare({ files: [pngFile] })) {
        await navigator.share({
          files: [pngFile],
          title: `Struk ${currentReceipt.idTrx}`,
          text: `Struk Belanja ${currentReceipt.pengaturan.namaToko}`
        });
      } else {
        // Fallback unduh PNG jika browser tidak mendukung Web Share file
        const url = URL.createObjectURL(pngBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        window.POS_AUTH.showToast("Gambar struk PNG (384px) diunduh.", "success");
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        // User menutup sheet Share iOS secara normal
      } else {
        window.POS_AUTH.showToast(
          "Gagal membuat gambar struk: " + (err.message || "Coba lagi."),
          "error"
        );
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML =
          '<i class="fas fa-share-nodes"></i> Share / Cetak Gambar Struk 58mm (PNG)';
      }
    }
  }

  // ==========================================================================
  // 5. CETAK BROWSER / PDF & KIRIM TEKS WHATSAPP
  // ==========================================================================

  function printBrowserPdf() {
    window.print();
  }

  function shareWhatsApp() {
    if (!currentReceipt) {
      window.POS_AUTH.showToast("Belum ada data struk.", "error");
      return;
    }

    const r = currentReceipt;
    const itemLines = r.items
      .map((it) => {
        const qty = Number(it.qty) || 0;
        const harga = Number(it.harga) || 0;
        const sub = Number(it.subtotal) || qty * harga;
        return `• ${it.nama}\n  ${qty} x ${formatRp(harga)} = ${formatRp(sub)}`;
      })
      .join("\n");

    let pesan = `*${r.pengaturan.namaToko}*\n`;
    pesan += `${r.pengaturan.alamatToko}\n`;
    pesan += `----------------------------\n`;
    pesan += `No Nota : ${r.idTrx}\n`;
    pesan += `Tanggal : ${r.tanggal} ${r.waktu}\n`;
    pesan += `Pelanggan: ${r.pelanggan}\n`;
    pesan += `Status  : *${r.status.toUpperCase()}*\n`;
    pesan += `----------------------------\n`;
    pesan += `${itemLines}\n`;
    pesan += `----------------------------\n`;
    if (r.diskonTotal > 0) {
      pesan += `Subtotal: ${formatRp(r.subtotal)}\n`;
      pesan += `Diskon  : -${formatRp(r.diskonTotal)}\n`;
    }
    pesan += `*TOTAL  : ${formatRp(r.totalBelanja)}*\n`;
    if (r.status === "Hutang") {
      pesan += `DP/Bayar: ${formatRp(r.bayar)}\n`;
      pesan += `*SISA HUTANG: ${formatRp(r.sisaHutang)}*\n`;
    } else {
      pesan += `Bayar (${r.metode}): ${formatRp(r.bayar)}\n`;
      pesan += `Kembalian: ${formatRp(r.kembalian)}\n`;
    }
    pesan += `----------------------------\n`;
    pesan += `${r.pengaturan.footerStruk}`;

    // Normalisasi nomor WA jika tersedia di data pelanggan
    let phone = String(r.noWa || "").replace(/[^\d]/g, "");
    if (phone.startsWith("0")) phone = "62" + phone.slice(1);

    const waUrl = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(pesan)}`
      : `https://wa.me/?text=${encodeURIComponent(pesan)}`;

    window.open(waUrl, "_blank", "noopener");
  }

  return {
    renderReceipt,
    openReceipt,
    printBluetoothEscPos,
    printRawBT,
    shareOrPrintIosPng,
    printBrowserPdf,
    shareWhatsApp
  };
})();