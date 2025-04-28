const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mkdirp = require("mkdirp");
const pLimit = require("p-limit").default;
const MinioService = require("./minioService");
const { minioClient } = require("./minioService");

const prisma = new PrismaClient();
const downloadLimit = pLimit(10); // Tối đa 10 download song song

const BUCKET_NAME = process.env.MINIO_BUCKET || "plants";

//Download ảnh từ URL và lưu vào thư mục cục bộ
async function downloadImage(url, folder, filenamePrefix) {
  try {
    const urlObj = new URL(url);
    let ext = path.extname(urlObj.pathname);

    if (!ext) {
      const response = await axios.head(url);
      const contentType = response.headers["content-type"];
      if (contentType === "image/jpeg") ext = ".jpg";
      else if (contentType === "image/png") ext = ".png";
      else if (contentType === "image/webp") ext = ".webp";
      else ext = ".jpg";
    }

    const filename = `${filenamePrefix}${ext}`;
    const filePath = path.join(folder, filename);

    if (fs.existsSync(filePath)) {
      console.log(`🗂️ File already exists locally: ${filename}`);
      // Nếu đã tồn tại -> không download lại
      return {
        success: true,
        filePath,
        contentType,
        filename,
      };
    }

    const response = await axios.get(url, { responseType: "arraybuffer" });

    fs.writeFileSync(filePath, response.data);
    return {
      success: true,
      filePath,
      contentType: response.headers["content-type"],
      filename,
    };
  } catch (err) {
    console.warn(`⚠️ Failed to download ${url}: ${err.message}`);
    return { success: false };
  }
}

// Upload ảnh lên Minio
async function uploadToMinio(localPath, objectName, contentType) {
  try {
    await MinioService.ensureBucketExists(BUCKET_NAME);

    const metaData = {
      "Content-Type": contentType,
    };

    await minioClient.fPutObject(BUCKET_NAME, objectName, localPath, metaData);

    const publicUrl = `${process.env.MINIO_PUBLIC_URL}/${BUCKET_NAME}/${objectName}`;

    return { success: true, url: publicUrl };
  } catch (error) {
    console.warn(`⚠️ Failed to upload to Minio: ${error.message}`);
    return { success: false };
  }
}

// Download ảnh từ URL và upload lên Minio
async function downloadAndUploadImage(url, saveDir, filenamePrefix) {
  const downloadResult = await downloadImage(url, saveDir, filenamePrefix);
  if (!downloadResult.success) return null;

  const { filePath, contentType, filename } = downloadResult;
  const objectName = `${filename}`;

  const uploadResult = await uploadToMinio(filePath, objectName, contentType);

  if (uploadResult.success) {
    return uploadResult.url;
  } else {
    return null;
  }
}

// Xử lý từng cây (download, upload ảnh và cập nhật DB)
async function processPlant(plant, saveDir) {
  const minioDomain = process.env.MINIO_PUBLIC_URL;

  const currentBackupUrls = Array.isArray(plant.image_backup_url)
    ? plant.image_backup_url
    : [];
  const minioUrls = currentBackupUrls.filter((url) =>
    url.startsWith(minioDomain)
  );

  if (minioUrls.length >= 3) {
    console.log(
      `Plant ID ${plant.id} already processed with Minio URLs. Skipping.`
    );
    return true;
  }
  const prefix = `${plant.id}_${(plant.species || "unknown").replace(
    /\s+/g,
    "_"
  )}`;
  console.log(
    `\n🌿 Processing: ${plant.species || "Unknown"} (ID: ${plant.id})`
  );

  const originalUrls = Array.isArray(plant.original_url)
    ? plant.original_url.filter(Boolean)
    : [];
  const backupUrls = Array.isArray(plant.image_backup_url)
    ? plant.image_backup_url.filter(Boolean)
    : [];

  let newBackupUrls = [];
  let downloadedCount = 0;

  const tryDownloadAndUpload = async (urls, type) => {
    for (let i = 0; i < urls.length && downloadedCount < 3; i++) {
      const filenamePrefix = `${prefix}_${type}${i + 1}`;
      const uploadedUrl = await downloadLimit(() =>
        downloadAndUploadImage(urls[i], saveDir, filenamePrefix)
      );
      if (uploadedUrl) {
        newBackupUrls.push(uploadedUrl);
        downloadedCount++;
      }
    }
  };

  await tryDownloadAndUpload(originalUrls, "original");

  if (downloadedCount < 3) {
    await tryDownloadAndUpload(backupUrls, "backup");
  }

  // luôn luôn update dù success hay fail
  if(newBackupUrls.length > 0) {
    await prisma.plantInfo.update({
      where: { id: plant.id },
      data: {
        image_backup_url: newBackupUrls,
      },
    });
  }
  
  if (newBackupUrls.length === 3) {
    console.log(`✅ Plant ID ${plant.id} processed successfully.`);
    console.log(`   - Uploaded 3 images.`);
    return true;
  } else {
    console.log(
      `❌ Plant ID ${plant.id} failed. Uploaded only ${newBackupUrls.length} images.`
    );
    return false;
  }
}

async function main() {
  const saveDir = path.join(__dirname, "downloads");
  mkdirp.sync(saveDir);

  const batchSize = 100;
  let skip = 0;
  let hasMore = true;
  let batchCount = 1;

  let successCount = 0;
  let failCount = 0;

  while (hasMore) {
    const plants = await prisma.plantInfo.findMany({
      skip,
      take: batchSize,
      select: {
        id: true,
        species: true,
        original_url: true,
        image_backup_url: true,
      },
    });

    if (plants.length === 0) {
      hasMore = false;
      break;
    }

    for (const plant of plants) {
      const success = await processPlant(plant, saveDir);
      if (success) successCount++;
      else failCount++;
    }

    skip += batchSize;
    batchCount++;
  }

  console.log("\n🎯 Process Summary:");
  console.log(`✅ Success plants: ${successCount}`);
  console.log(`❌ Failed plants: ${failCount}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
