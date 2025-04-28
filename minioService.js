const Minio = require('minio');

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: process.env.MINIO_PORT,
  useSSL: process.env.MINIO_SECURE === false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
class MinioService {
  /**
   * Check if bucket exists, create it if not
   */
  static async ensureBucketExists(bucketName) {
    try {
      const exists = await minioClient.bucketExists(bucketName);
      if (!exists) {
        await minioClient.makeBucket(bucketName, 'local');

        // Set bucket policy to allow public read access (optional)
        const policy = {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${bucketName}/*`],
            },
          ],
        };
        await minioClient.setBucketPolicy(bucketName, JSON.stringify(policy));
      }
      return true;
    } catch (error) {
      console.log(`Error ensuring bucket exists: ${error}`);
      throw error;
    }
  }
}

module.exports = MinioService;
module.exports.minioClient = minioClient;
