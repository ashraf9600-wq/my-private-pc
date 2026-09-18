import { isAquaticRequest } from "./intent.mjs";

export function rphInstructions(request) {
  const aquatic = isAquaticRequest(request)
    ? "Permintaan menyebut kandungan akuatik. Jangan hasilkan aktiviti akuatik; pilih kandungan RPT bukan akuatik yang seterusnya."
    : "Untuk Pendidikan Jasmani, sentiasa elakkan renang dan semua aktiviti akuatik.";
  return [
    "Hasilkan RPH praktikal dalam Bahasa Melayu dan gunakan semua medan RPH yang diberi dalam konteks.",
    "Semak kemajuan class+subject dalam konteks. Sambung SK/SP/tajuk terakhir; jangan mulakan topik secara rawak.",
    "Jika kemajuan belum disimpan, nyatakan maklumat SK/SP terakhir belum ada dan buat cadangan yang jelas sebagai cadangan, bukan fakta.",
    "Gunakan format refleksi berangka yang diberikan.",
    aquatic,
    "RPH ini berstatus planned sehingga bos mengesahkan ia sudah diajar.",
  ].join(" ");
}
