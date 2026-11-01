import assert from "node:assert/strict";
import test from "node:test";
import { loadBackground } from "./helpers/background.mjs";

const ownDownload = (url, filename) => ({ byExtensionId: "test-extension-id", url, filename });

test("keeps Chrome's requested subfolder when the URL target cannot be matched", async () => {
  const { determine } = loadBackground();
  const args = await determine(ownDownload(
    "https://scontent.cdninstagram.com/image.jpg?redirected=1",
    "C:\\Users\\test\\Downloads\\Instagram\\_amcamy\\post_01.jpg"
  ));
  assert.equal(args.length, 0, "suggest() with no override preserves Chrome's requested path");
});

test("uses the queued platform/account path when the URL target matches", async () => {
  const url = "https://scontent.cdninstagram.com/image.jpg";
  const { determine } = loadBackground({ storage: { downloadTargets: { [url]: ["Instagram/_amcamy/post_01.jpg"] } } });
  const args = await determine(ownDownload(url, "C:\\Users\\test\\Downloads\\post_01.jpg"));
  assert.equal(args[0].filename, "Instagram/_amcamy/post_01.jpg");
  assert.equal(args[0].conflictAction, "uniquify");
});

test("preserves Chrome's requested path if target lookup fails", async () => {
  const { determine } = loadBackground({ failStorageGet: true });
  const args = await determine(ownDownload(
    "https://scontent.cdninstagram.com/image.jpg",
    "C:\\Users\\test\\Downloads\\Instagram\\_amcamy\\post_01.jpg"
  ));
  assert.equal(args.length, 0);
});

test("uses overwrite only for a verified repair target", async () => {
  const url = "https://scontent.cdninstagram.com/image.jpg";
  const target = { filename: "Instagram/11_14_42/Da8SklSvuJY_01.jpg", conflictAction: "overwrite" };
  const { determine } = loadBackground({ storage: { downloadTargets: { [url]: [target] } } });
  const args = await determine(ownDownload(url, "C:\\Users\\test\\Downloads\\Da8SklSvuJY_01.jpg"));
  assert.equal(args[0].filename, target.filename);
  assert.equal(args[0].conflictAction, "overwrite");
});
