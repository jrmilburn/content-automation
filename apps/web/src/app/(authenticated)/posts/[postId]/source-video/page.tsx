import { loadObjectStorageConfig } from "@studio-parallel/config";
import { notFound } from "next/navigation";

import { VideoUpload } from "../../../../../components/video-upload";
import { requireShellActor } from "../../../../../lib/server/shell-session";
import { loadSourceVideoPost } from "../../../../../lib/server/source-video-data";

export const dynamic = "force-dynamic";

/**
 * Source-video upload for one imported post.
 *
 * This is deliberately a narrow page rather than a post detail screen: unified
 * post detail is a separate outcome, and putting the upload control there first
 * would mean shipping half of it. What lives here is only what an upload needs
 * — proof the post belongs to the caller's workspace, and the control itself.
 */
export default async function SourceVideoPage({
  params,
}: Readonly<{ params: Promise<Readonly<{ postId: string }>> }>) {
  const { postId } = await params;
  const actor = await requireShellActor();
  const post = await loadSourceVideoPost(actor, postId);

  if (post === null) {
    notFound();
  }

  return (
    <>
      <header className="page-header">
        <h1>Source video</h1>
        <p>
          Attach the original video for this {post.mediaKind === "REEL" ? "reel" : "post"} so it can
          be analysed. Instagram does not provide the original file.
        </p>
      </header>
      {/* The limit is read from configuration rather than written into the
          control, so the advertised number cannot drift from the one the
          server enforces. */}
      <VideoUpload maxBytes={loadObjectStorageConfig().UPLOAD_MAX_BYTES} postId={post.id} />
    </>
  );
}
