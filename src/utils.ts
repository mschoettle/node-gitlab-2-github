import { S3Settings } from './settings';
import * as mime from 'mime-types';
import * as path from 'path';
import * as crypto from 'crypto';
import S3 from 'aws-sdk/clients/s3';
import { GitlabHelper } from './gitlabHelper';

const util = require('util');
const exec = util.promisify(require('child_process').exec);

export const sleep = (milliseconds: number) => {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
};

// Creates new attachments and replaces old links
export const migrateAttachments = async (
  body: string,
  githubRepoId: number | undefined,
  s3: S3Settings | undefined,
  gitlabHelper: GitlabHelper
) => {
  const regexp = /(!?)\[([^\]]+)\]\((\/uploads[^)]+)\)/g;

  // Maps link offset to a new name in S3
  const offsetToAttachment: {
    [key: number]: string;
  } = {};

  // Find all local links
  const matches = body.matchAll(regexp);

  for (const match of matches) {
    const prefix = match[1] || '';
    const name = match[2];
    const url = match[3];

    if (s3 && s3.bucket) {
      const basename = path.basename(url);
      const mimeType = mime.lookup(basename);
      const attachmentBuffer = await gitlabHelper.getAttachment(url);
      if (!attachmentBuffer) {
        continue;
      }

      // // Generate file name for S3 bucket from URL
      const hash = crypto.createHash('sha256');
      hash.update(url);
      const newFileName = hash.digest('hex') + '/' + basename;
      const relativePath = githubRepoId
        ? `${githubRepoId}/${newFileName}`
        : newFileName;
      // Doesn't seem like it is easy to upload an issue to github, so upload to S3
      //https://stackoverflow.com/questions/41581151/how-to-upload-an-image-to-use-in-issue-comments-via-github-api

      // Attempt to fix issue #140
      //const s3url = `https://${s3.bucket}.s3.amazonaws.com/${relativePath}`;
      let hostname = `${s3.bucket}.s3.amazonaws.com`;
      if (s3.region) {
        hostname = `s3.${s3.region}.amazonaws.com/${s3.bucket}`;
      }
      const s3url = `https://${hostname}/${relativePath}`;

      const s3bucket = new S3();
      s3bucket.createBucket(() => {
        const params: S3.PutObjectRequest = {
          Key: relativePath,
          Body: attachmentBuffer,
          ContentType: mimeType === false ? undefined : mimeType,
          Bucket: s3.bucket,
        };

        s3bucket.upload(params, function (err, data) {
          console.log(`\tUploading ${basename} to ${s3url}... `);
          if (err) {
            console.log('ERROR: ', err);
          } else {
            console.log(`\t...Done uploading`);
          }
        });
      });

      // Add the new URL to the map
      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${s3url})`;
    } else {
      // Not using S3: default to old URL, adding absolute path
      const attachmentBuffer = await gitlabHelper.getAttachment(url);
      if (!attachmentBuffer) {
        throw new Error(`Attachment ${url} not downloaded`);
      }
      const basename = path.basename(url);
      const mimeType = mime.lookup(basename);
      // save attachmentBuffer to file
      const fs = require('fs');
      const tempFilePath = `/tmp/${path.basename(url)}`;
      fs.writeFileSync(tempFilePath, attachmentBuffer);
      console.log(`Saved attachment to ${tempFilePath}`);

      console.log('Uploading attachment to GitHub via github-s3...');
      const { stdout, stderr } = await exec(`github-s3 ${tempFilePath}`);
      console.log(`Uploaded attachment URL: ${stdout.trim()}`);

      if (stderr) {
        throw new Error(stderr);
      }
      
      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${stdout.trim()})`;
    }
  }

  return body.replace(
    regexp,
    ({}, {}, {}, {}, offset, {}) => offsetToAttachment[offset]
  );
};
