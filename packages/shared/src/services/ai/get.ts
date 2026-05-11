import db from "../../db";

export const getConversation = async (data: {
  id: string;
  teamId: string;
  userId: string;
}) => {
  const { id, teamId, userId } = data;

  return db.query.aiConversations.findFirst({
    where: { id, teamId, userId },
  });
};
