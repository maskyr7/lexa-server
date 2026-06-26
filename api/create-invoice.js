module.exports = async (req, res) => {
  return res.status(200).json({
    success: true,
    message: "LEXA Server OK"
  });
};